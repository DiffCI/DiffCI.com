/**
 * Ephemeral self-hosted GitHub Actions runner dispatcher. Deployed via wrangler.github-runner.jsonc.
 *
 * Flow: GitHub sends a `workflow_job` webhook -> this Worker verifies it, and if the job's labels
 * request `[self-hosted, cloudflare]` (workflows must opt in explicitly - see the README note this
 * script prints), it mints a short-lived runner-registration token via the GitHub App installed on
 * the repo, and starts ONE Cloudflare Container instance (ops/github-runner/Dockerfile) with that
 * token. The container registers itself as a single `--ephemeral` runner, runs exactly that one job,
 * deregisters, and exits - the container instance then goes away. No GitHub Actions minutes are
 * consumed (self-hosted runner compute is never billed by GitHub); the Actions control plane
 * (queuing, logs, the workflow YAML, status checks) is still GitHub's.
 *
 * THIS IS CODE ONLY until a GitHub App is registered and installed on both DiffCI.com and
 * DentalPresence.in with the `workflow_job` webhook subscribed and Administration:write +
 * Actions:write repo permissions - see src/shadow/github-app.ts's file doc comment for the same
 * caveat on the auth primitives this module reuses. Until then this Worker can be deployed but will
 * 401 on `/webhook` (GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY secrets unset) and reject every delivery
 * (GITHUB_WEBHOOK_SECRET unset).
 */
import { Container, getContainer } from "@cloudflare/containers";
import { signAppJwt, exchangeInstallationToken, verifyWebhookSignature } from "../../shadow/github-app.js";

// Labels a workflow's `runs-on:` array must include for this dispatcher to claim the job. Anything
// else (plain `runs-on: ubuntu-latest`, or another self-hosted fleet's labels) is left alone -
// GitHub-hosted runners keep working normally for jobs that don't ask for these labels.
const CLAIM_LABELS = ["self-hosted", "cloudflare"];

export class GithubRunner extends Container {
  // No defaultPort/requiredPorts: this container serves no HTTP traffic and is never fetch()'d, only
  // start()'d - see the Dockerfile's ENTRYPOINT note.
  //
  // sleepAfter is NOT irrelevant despite that (an earlier comment here claimed it was): the
  // @cloudflare/containers activity timeout counts fetches, and a runner container never receives
  // any - so the default sleepAfter stops the container while it is innocently waiting for GitHub to
  // assign it the queued job ("Activity expired, signalling container to stop"), which surfaces as
  // "container exited normally, job stuck queued forever" (the sixth debugging trigger, 2026-08-21).
  // 45 minutes comfortably exceeds any CI job this fleet runs; the process still exits on its own
  // the moment its one job finishes, so the timeout only matters as a stuck-container backstop.
  override sleepAfter: string | number = "45m";
  override onStop() {
    console.log("github-runner: container exited (job finished or runner failed to register)");
  }
  override onError(error: unknown) {
    console.log("github-runner: container error", error);
  }
}

interface WorkflowJobEvent {
  action: string;
  workflow_job: { id: number; labels: string[] };
  repository: { name: string; owner: { login: string } };
  installation?: { id: number };
}

// This project's tsconfig deliberately omits @cloudflare/workers-types (see github-app.ts's note on
// Node/Workers portability), so the ambient DurableObjectNamespace/ExecutionContext names don't
// exist here. Derive the namespace type from getContainer's own signature and declare the one
// ExecutionContext method actually used - the same hand-rolled-interface pattern as
// validation-worker.ts's D1Binding/R2Binding/ExecutionCtx.
type RunnerNamespace = Parameters<typeof getContainer>[0];
interface ExecutionCtx {
  waitUntil(promise: Promise<unknown>): void;
}

interface RunnerEnv {
  GITHUB_RUNNER: RunnerNamespace;
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  // Single installation id covers both repos IF the App is installed once at the adityankale190895
  // account level with both DiffCI.com and DentalPresence.in selected. If they end up as separate
  // installations, switch this to a per-owner lookup (env.GITHUB_APP_INSTALLATION_ID_<OWNER>) - the
  // webhook payload's `installation.id` (present on every App-sourced delivery) makes that trivial;
  // this constant is only a fallback for manual/local testing without a live delivery.
  GITHUB_APP_INSTALLATION_ID?: string;
  /** Bearer token for the /app-info diagnostic route only - webhook auth is GitHub's HMAC, never this. */
  RUNNER_DISPATCH_TOKEN?: string;
}

/** Diagnostic twin of validation-worker.ts's shadowAppInfo, for THIS Worker's (write-scoped runner)
 * App: what GitHub has on file (events/permissions) plus its recent webhook deliveries with our
 * stored responses - added when workflow_job deliveries returned Ok yet no dispatch log ever
 * appeared, which is indistinguishable from "wrong event subscription" and "signature mismatch"
 * without GitHub's own delivery log. Delivery ids exceed Number.MAX_SAFE_INTEGER - extracted from
 * the raw body text, never JSON.parsed (same bug as the shadow App debugging found). */
async function runnerAppInfo(env: RunnerEnv, deliveryId?: string | null, workerOrigin?: string): Promise<Response> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    return Response.json({ ok: false, error: "app-credentials-not-configured" }, { status: 503 });
  }
  const jwt = await signAppJwt({ appId: env.GITHUB_APP_ID, privateKeyPkcs8Pem: env.GITHUB_APP_PRIVATE_KEY });
  const headers = { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "User-Agent": "diffci-github-runner" };

  // ?delivery=joblogs:<installationId>:<owner/repo>:<jobId> - fetch a completed job's full log via
  // the App installation token (actions:write includes log read). This is how CI failures on the
  // Cloudflare fleet get debugged from the terminal without the GitHub UI.
  if (deliveryId && deliveryId.startsWith("joblogs:")) {
    const [, installationId, repoFull, jobId] = deliveryId.split(":");
    if (!installationId || !/^\d+$/.test(installationId) || !repoFull || !/^[\w.-]+\/[\w.-]+$/.test(repoFull) || !jobId || !/^\d+$/.test(jobId)) {
      return Response.json({ ok: false, error: "expected joblogs:<installationId>:<owner/repo>:<jobId>" }, { status: 400 });
    }
    const installationToken = await exchangeInstallationToken(jwt, installationId);
    const logsRes = await fetch(`https://api.github.com/repos/${repoFull}/actions/jobs/${jobId}/logs`, {
      headers: { Authorization: `token ${installationToken.token}`, Accept: "application/vnd.github+json", "User-Agent": "diffci-github-runner" },
    });
    if (!logsRes.ok) return Response.json({ ok: false, error: `job logs fetch failed (${logsRes.status})` }, { status: 502 });
    const text = await logsRes.text();
    // The interesting part of a failed job is its tail.
    return new Response(text.slice(-30_000), { headers: { "Content-Type": "text/plain" } });
  }

  // ?delivery=fleet:<installationId>:<owner/repo> - the whole picture at once: registered runners
  // (name/status/busy) and every queued + in-progress workflow run. THE first thing to check when
  // "jobs are queued but nothing picks them up".
  if (deliveryId && deliveryId.startsWith("fleet:")) {
    const [, installationId, repoFull] = deliveryId.split(":");
    if (!installationId || !/^\d+$/.test(installationId) || !repoFull || !/^[\w.-]+\/[\w.-]+$/.test(repoFull)) {
      return Response.json({ ok: false, error: "expected fleet:<installationId>:<owner/repo>" }, { status: 400 });
    }
    const installationToken = await exchangeInstallationToken(jwt, installationId);
    const ghHeaders = { Authorization: `token ${installationToken.token}`, Accept: "application/vnd.github+json", "User-Agent": "diffci-github-runner" };
    const [runnersRes, queuedRes, inProgressRes] = await Promise.all([
      fetch(`https://api.github.com/repos/${repoFull}/actions/runners`, { headers: ghHeaders }),
      fetch(`https://api.github.com/repos/${repoFull}/actions/runs?status=queued&per_page=30`, { headers: ghHeaders }),
      fetch(`https://api.github.com/repos/${repoFull}/actions/runs?status=in_progress&per_page=30`, { headers: ghHeaders }),
    ]);
    const runners = runnersRes.ok ? ((await runnersRes.json()) as { runners?: Array<{ id: number; name: string; status: string; busy: boolean }> }).runners : `runners fetch failed (${runnersRes.status})`;
    const mapRuns = (body: { workflow_runs?: Array<{ id: number; head_sha: string; created_at: string; status: string }> }) =>
      (body.workflow_runs ?? []).map((r) => ({ runId: r.id, headSha: r.head_sha.slice(0, 7), createdAt: r.created_at, status: r.status }));
    const queued = queuedRes.ok ? mapRuns((await queuedRes.json()) as never) : `queued fetch failed (${queuedRes.status})`;
    const inProgress = inProgressRes.ok ? mapRuns((await inProgressRes.json()) as never) : `in-progress fetch failed (${inProgressRes.status})`;
    return Response.json({ ok: true, runners, queued, inProgress });
  }

  // ?delivery=drain:<installationId>:<owner/repo>:<count> - start N fresh runner containers, each of
  // which claims one queued job (oldest first, GitHub's choice). Recovery tool for a starved queue:
  // jobs whose original queued-webhook containers died (the CRLF/ICU debugging era) never get another
  // container, because GitHub does not re-deliver workflow_job.queued for them.
  if (deliveryId && deliveryId.startsWith("drain:")) {
    const [, installationId, repoFull, countRaw] = deliveryId.split(":");
    const count = Math.max(1, Math.min(5, Number.parseInt(countRaw ?? "1", 10) || 1));
    if (!installationId || !/^\d+$/.test(installationId) || !repoFull || !/^[\w.-]+\/[\w.-]+$/.test(repoFull)) {
      return Response.json({ ok: false, error: "expected drain:<installationId>:<owner/repo>:<count>" }, { status: 400 });
    }
    const [owner, repo] = repoFull.split("/");
    const started: string[] = [];
    for (let i = 0; i < count; i++) {
      const token = await mintRegistrationToken(env, owner!, repo!, Number(installationId));
      const name = `drain-${crypto.randomUUID().slice(0, 8)}`;
      const container = getContainer(env.GITHUB_RUNNER, name);
      await container.start({
        envVars: {
          GH_OWNER: owner!, GH_REPO: repo!, RUNNER_TOKEN: token, RUNNER_LABELS: CLAIM_LABELS.join(","), LOG_TAG: name,
          LOG_SINK_URL: `${workerOrigin ?? ""}/container-log`, LOG_SINK_TOKEN: env.RUNNER_DISPATCH_TOKEN ?? "",
        },
      });
      started.push(name);
    }
    return Response.json({ ok: true, started });
  }

  // ?delivery=runs:<installationId>:<owner/repo>:<headSha> - workflow runs for one commit, the
  // queue-noise-free way to answer "did MY push's CI pass" while stale queued jobs drain.
  if (deliveryId && deliveryId.startsWith("runs:")) {
    const [, installationId, repoFull, headSha] = deliveryId.split(":");
    if (!installationId || !/^\d+$/.test(installationId) || !repoFull || !/^[\w.-]+\/[\w.-]+$/.test(repoFull) || !headSha || !/^[0-9a-f]{7,40}$/.test(headSha)) {
      return Response.json({ ok: false, error: "expected runs:<installationId>:<owner/repo>:<headSha>" }, { status: 400 });
    }
    const installationToken = await exchangeInstallationToken(jwt, installationId);
    const runsRes = await fetch(`https://api.github.com/repos/${repoFull}/actions/runs?head_sha=${headSha}`, {
      headers: { Authorization: `token ${installationToken.token}`, Accept: "application/vnd.github+json", "User-Agent": "diffci-github-runner" },
    });
    if (!runsRes.ok) return Response.json({ ok: false, error: `runs fetch failed (${runsRes.status})` }, { status: 502 });
    const body = (await runsRes.json()) as { workflow_runs?: Array<{ id: number; name: string; status: string; conclusion: string | null; head_sha: string; created_at: string }> };
    return Response.json({
      ok: true,
      runs: (body.workflow_runs ?? []).map((r) => ({ runId: r.id, name: r.name, status: r.status, conclusion: r.conclusion, headSha: r.head_sha.slice(0, 7), createdAt: r.created_at })),
    });
  }

  if (deliveryId && /^\d{1,25}$/.test(deliveryId)) {
    const detailRes = await fetch(`https://api.github.com/app/hook/deliveries/${deliveryId}`, { headers });
    if (!detailRes.ok) return Response.json({ ok: false, error: `delivery detail failed (${detailRes.status})` }, { status: 502 });
    const detail = (await detailRes.json()) as {
      event: string; action: string | null; status_code: number; response?: { payload?: unknown };
      request?: { payload?: { workflow_job?: { id?: number; labels?: string[]; conclusion?: string | null; runner_name?: string | null; started_at?: string; completed_at?: string; steps?: Array<{ name: string; conclusion: string | null }> }; repository?: { full_name?: string } } };
    };
    const job = detail.request?.payload?.workflow_job;
    return Response.json({
      ok: true, event: detail.event, action: detail.action, statusCode: detail.status_code,
      ourResponse: detail.response?.payload, jobId: job?.id, jobLabels: job?.labels,
      conclusion: job?.conclusion ?? null, runnerName: job?.runner_name ?? null,
      startedAt: job?.started_at, completedAt: job?.completed_at,
      steps: (job?.steps ?? []).map((s) => `${s.name}: ${s.conclusion ?? "?"}`),
      repository: detail.request?.payload?.repository?.full_name,
    });
  }

  const appRes = await fetch("https://api.github.com/app", { headers });
  if (!appRes.ok) return Response.json({ ok: false, error: `GET /app failed (${appRes.status})` }, { status: 502 });
  const app = (await appRes.json()) as { slug?: string; events?: string[]; permissions?: Record<string, string> };
  const deliveriesRes = await fetch("https://api.github.com/app/hook/deliveries?per_page=15", { headers });
  let deliveries: unknown = `deliveries fetch failed (${deliveriesRes.status})`;
  if (deliveriesRes.ok) {
    const raw = await deliveriesRes.text();
    const exactIds = [...raw.matchAll(/"id":\s*(\d+)/g)].map((m) => m[1]!);
    const parsed = JSON.parse(raw) as Array<{ event: string; action: string | null; status: string; status_code: number; delivered_at: string }>;
    deliveries = parsed.map((d, i) => ({ id: exactIds[i], event: d.event, action: d.action, status: d.status, statusCode: d.status_code, deliveredAt: d.delivered_at }));
  }
  return Response.json({ ok: true, slug: app.slug, events: app.events, permissions: app.permissions, recentDeliveries: deliveries });
}

async function mintRegistrationToken(env: RunnerEnv, owner: string, repo: string, installationId: number): Promise<string> {
  const appJwt = await signAppJwt({ appId: env.GITHUB_APP_ID, privateKeyPkcs8Pem: env.GITHUB_APP_PRIVATE_KEY });
  const installationToken = await exchangeInstallationToken(appJwt, String(installationId));
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/runners/registration-token`, {
    method: "POST",
    headers: {
      Authorization: `token ${installationToken.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
      // Required - see the matching comment on exchangeInstallationToken in github-app.ts. GitHub's
      // API firewall 403s any request with no User-Agent, which the Workers fetch runtime never adds.
      "User-Agent": "DiffCI-App",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`registration-token request failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const body = (await res.json()) as { token: string };
  return body.token;
}

async function handleWorkflowJob(event: WorkflowJobEvent, env: RunnerEnv, ctx: ExecutionCtx, workerOrigin: string): Promise<void> {
  console.log("github-runner: received workflow_job", event.action, event.workflow_job?.labels);
  if (event.action !== "queued") return; // ignore in_progress/completed - we only ever START runners
  const labels = event.workflow_job.labels ?? [];
  if (!CLAIM_LABELS.every((l) => labels.includes(l))) {
    console.log("github-runner: labels didn't match, ignoring", labels);
    return; // not addressed to this fleet
  }

  const owner = event.repository.owner.login;
  const repo = event.repository.name;
  const installationId = event.installation?.id ?? (env.GITHUB_APP_INSTALLATION_ID ? Number(env.GITHUB_APP_INSTALLATION_ID) : undefined);
  if (!installationId) throw new Error("no installation id on webhook payload and no GITHUB_APP_INSTALLATION_ID fallback set");
  console.log("github-runner: dispatching", owner, repo, "job", event.workflow_job.id, "installation", installationId);

  // Do the actual dispatch in the background: GitHub expects the webhook endpoint to respond within
  // ~10s, and minting a token + starting a container comfortably exceeds that under cold start.
  ctx.waitUntil(
    (async () => {
      const token = await mintRegistrationToken(env, owner, repo, installationId);
      console.log("github-runner: minted registration token, starting container");
      // One container instance per job id - guarantees a fresh, uniquely-named instance even if two
      // jobs for the same repo queue at once, and makes retried webhook deliveries for the SAME job
      // id land on the SAME (already-started-or-starting) instance instead of double-spawning.
      const container = getContainer(env.GITHUB_RUNNER, `job-${event.workflow_job.id}`);
      await container.start({
        envVars: {
          GH_OWNER: owner,
          GH_REPO: repo,
          RUNNER_TOKEN: token,
          RUNNER_LABELS: CLAIM_LABELS.join(","),
          // Container-stdout exfiltration (entrypoint.sh): the container POSTs its own config.sh/
          // run.sh output back to this Worker's /container-log route, because wrangler tail can only
          // ever show the Worker's console - the sixth debugging trigger failed invisibly inside the
          // container for exactly this reason. Empty token disables it gracefully (entrypoint no-ops).
          LOG_SINK_URL: `${workerOrigin}/container-log`,
          LOG_SINK_TOKEN: env.RUNNER_DISPATCH_TOKEN ?? "",
          LOG_TAG: `job-${event.workflow_job.id}`,
        },
      });
      console.log("github-runner: container.start() resolved for job", event.workflow_job.id);
    })().catch((err) => console.log("github-runner: dispatch failed", String(err), err?.stack)),
  );
}

export default {
  async fetch(request: Request, env: RunnerEnv, ctx: ExecutionCtx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/app-info" && request.method === "GET") {
      const auth = request.headers.get("Authorization") ?? "";
      if (!env.RUNNER_DISPATCH_TOKEN || auth !== `Bearer ${env.RUNNER_DISPATCH_TOKEN}`) {
        return new Response("unauthorized", { status: 401 });
      }
      return runnerAppInfo(env, url.searchParams.get("delivery"), url.origin);
    }
    if (url.pathname === "/container-log" && request.method === "POST") {
      // Receives entrypoint.sh's exfiltrated container stdout and re-emits it on the Worker console,
      // where wrangler tail and the observability logs can actually see it. Auth: same bearer as
      // /app-info - the token reaches the container as LOG_SINK_TOKEN via start() envVars only.
      const auth = request.headers.get("Authorization") ?? "";
      if (!env.RUNNER_DISPATCH_TOKEN || auth !== `Bearer ${env.RUNNER_DISPATCH_TOKEN}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const tag = (url.searchParams.get("tag") ?? "untagged").slice(0, 64);
      const body = (await request.text()).slice(0, 100_000);
      // Chunked so no single console.log line gets truncated by the log pipeline.
      for (let i = 0; i < body.length; i += 3000) {
        console.log(`container-log [${tag}] (${i / 3000 + 1}/${Math.ceil(body.length / 3000)}):\n${body.slice(i, i + 3000)}`);
      }
      return new Response("ok");
    }
    if (url.pathname !== "/webhook" || request.method !== "POST") return new Response("not found", { status: 404 });

    // Signature must be verified against the RAW body - read as text first, never parse-then-reserialize.
    const rawBody = await request.text();
    const signature = request.headers.get("X-Hub-Signature-256");
    const eventName0 = request.headers.get("X-GitHub-Event");
    const hookId = request.headers.get("X-GitHub-Hook-ID");
    const targetType = request.headers.get("X-GitHub-Hook-Installation-Target-Type");
    if (!(await verifyWebhookSignature(rawBody, signature, env.GITHUB_WEBHOOK_SECRET))) {
      // Header metadata only, never the body - enough to identify WHICH webhook (hook id + target
      // type: 'integration' = a GitHub App, 'repository' = a classic repo-level webhook) is posting
      // with the wrong secret, without logging attacker-controllable payload content.
      console.log(`github-runner: SIGNATURE REJECTED event=${eventName0} hookId=${hookId} targetType=${targetType} signaturePresent=${signature !== null}`);
      return new Response("invalid signature", { status: 401 });
    }
    console.log(`github-runner: verified delivery event=${eventName0} hookId=${hookId} targetType=${targetType}`);

    const eventName = request.headers.get("X-GitHub-Event");
    if (eventName !== "workflow_job") return new Response("ignored", { status: 202 });

    const event = JSON.parse(rawBody) as WorkflowJobEvent;
    await handleWorkflowJob(event, env, ctx, url.origin);
    return new Response("accepted", { status: 202 });
  },
};
