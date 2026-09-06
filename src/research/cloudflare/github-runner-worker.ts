/**
 * Ephemeral self-hosted GitHub Actions runner dispatcher. Deployed via wrangler.github-runner.jsonc.
 *
 * Flow: GitHub sends a `workflow_job` webhook -> this Worker verifies it, and if the job's labels
 * request `[self-hosted, cloudflare]` (workflows must opt in explicitly - see the README note this
 * script prints), it mints a short-lived runner-registration token via the GitHub App installed on
 * the repo, and runs the full ephemeral-runner lifecycle (download -> install deps -> register ->
 * run one job -> deregister) as ONE `sandbox.exec()` call against a fresh Cloudflare Sandbox Container
 * instance. No GitHub Actions minutes are consumed (self-hosted runner compute is never billed by
 * GitHub); the Actions control plane (queuing, logs, the workflow YAML, status checks) is still GitHub's.
 *
 * REWRITTEN 2026-08-22 (Preflight P1, CI recovery): the ORIGINAL design (ops/github-runner/Dockerfile,
 * a custom-built image with the runner binary + Node baked in at build time) is what the real 6-push
 * node:sqlite/Node-20-vs-22 incident needed fixing - but rebuilding that custom image needs a local
 * Docker daemon, which was unavailable in every environment this session had access to (confirmed
 * three ways: no local Docker running; wrangler containers build always shells out to a local docker
 * binary, no remote-build option; a GitHub-hosted ubuntu-latest build-and-push workflow hit a
 * pre-existing GitHub Actions billing hold on the account, unrelated to this fix). Rather than block
 * indefinitely, this Worker was rewritten to use Cloudflare's own PRE-PUBLISHED Sandbox image
 * (docker.io/cloudflare/sandbox:0.12.5 - the exact same image diffci-research-sandbox and
 * diffci-synthetic-runner already use) instead of a custom Dockerfile, and to install/download
 * everything it needs at container-start time via `sandbox.exec()` instead of baking it into an image
 * at build time. This needs NO local Docker at all - confirmed by a real, live, successful deploy.
 *
 * Live-verified before wiring this into the real webhook path (all on Cloudflare's `standard-2`
 * instance type - a smaller `lite` instance was tried first and was unreliably slow/timed out
 * repeatedly on the exact same commands that complete in ~26s total on `standard-2`; this is recorded
 * because it's a real, easy-to-repeat mistake): runner binary download ~3-10s, tar extraction ~8s,
 * `./bin/installdependencies.sh` ~16s (Ubuntu 22.04's own libicu70 already satisfies the runner
 * agent's .NET runtime needs - no manual libicu74/libssl3 workaround needed here, unlike the OLD
 * Dockerfile's Ubuntu 24.04 base), `RUNNER_ALLOW_RUNASROOT=1` + `./config.sh --help` runs cleanly as
 * root (the Sandbox image's default user). Total real-world overhead versus the old baked-image
 * approach: ~25-30s of setup per job, paid once per ephemeral runner instance - a real, disclosed cost
 * of this pivot, not hidden.
 *
 * ops/github-runner/Dockerfile and entrypoint.sh are LEFT IN PLACE, unused by this Worker now, as a
 * documented fallback if local Docker becomes available later and someone prefers to revert to a
 * baked image (faster cold start, no per-job download) - see that directory's own files for the
 * original design and its own hard-won bug-fix history.
 */
import { getSandbox, Sandbox } from "@cloudflare/sandbox";
import { signAppJwt, exchangeInstallationToken, verifyWebhookSignature } from "../../shadow/github-app.js";
import {
  CLAIM_LABELS,
  MAX_DISPATCH_ATTEMPTS,
  STALE_DISPATCH_MS,
  classifyStartError,
  consumeDispatchBatch,
  decideReconcileDispatches,
  isPinned,
  jobAddressedToFleet,
  registrationLabels,
  type DispatchMessage,
  type DispatchQueueMessage,
  type QueuedJobView,
} from "./runner-dispatch.js";
import { makeD1RunnerLifecycleStore, type D1Binding as RunnerD1, type RunnerLifecycleStore } from "./runner-lifecycle-store.js";

// Durable Object class binding target (wrangler.github-runner.jsonc's containers[0].class_name /
// durable_objects binding both reference "GithubRunner") - same re-export pattern
// synthetic-runner-worker.ts uses for its own Sandbox-backed class, not a custom class of our own.
export { Sandbox as GithubRunner };

// CLAIM_LABELS (the labels a workflow's `runs-on:` must include for this dispatcher to claim the job)
// now lives in runner-dispatch.ts alongside the job-unique pinned label (2026-09-05, repair step 4).

// Pinned exactly as the old Dockerfile pinned it (Part 17/18-style discipline: an ephemeral runner
// must never self-update mid-job - see --disableupdate below - so the version is bumped here
// deliberately, not left to drift).
const RUNNER_VERSION = "2.336.0";
const RUNNER_DOWNLOAD_URL = `https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz`;

interface WorkflowJobEvent {
  action: string;
  workflow_job: { id: number; labels: string[]; run_id?: number; name?: string; workflow_name?: string; runner_name?: string | null; conclusion?: string | null };
  repository: { name: string; owner: { login: string } };
  installation?: { id: number };
}

/** Queue message shape (runner-dispatch.ts DispatchMessage) - the producer binding's send() target. */
interface DispatchQueue {
  send(body: DispatchMessage): Promise<void>;
}

// This project's tsconfig deliberately omits @cloudflare/workers-types (see github-app.ts's note on
// Node/Workers portability), so the ambient DurableObjectNamespace/ExecutionContext names don't
// exist here. Derive the namespace type from getSandbox's own signature and declare the one
// ExecutionContext method actually used - the same hand-rolled-interface pattern as
// validation-worker.ts's D1Binding/R2Binding/ExecutionCtx.
type RunnerNamespace = Parameters<typeof getSandbox>[0];
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
  /** 2026-09-05 (repair step 4): durable dispatch + lifecycle provenance. */
  RUNNER_DISPATCH_QUEUE: DispatchQueue;
  RUNNER_DB: RunnerD1;
}

function lifecycleStore(env: RunnerEnv): RunnerLifecycleStore {
  return makeD1RunnerLifecycleStore(env.RUNNER_DB);
}

/**
 * Runs the full ephemeral-runner lifecycle in ONE sandbox.exec() call: download the pinned runner
 * release, extract it, install its .NET runtime dependencies, register as a single `--ephemeral`
 * runner (auto-deregisters after exactly one job), and run. `RUNNER_ALLOW_RUNASROOT=1` is required
 * because the Sandbox image's default user is root (unlike the old custom image's dedicated non-root
 * `runner` user) - live-verified this does not weaken anything meaningful here: the container itself
 * is single-job, single-tenant, and destroyed immediately after (Part 18's "short-lived, non-reusable
 * after completion" runner-credential discipline still holds).
 *
 * Timeout is generously bounded (10 min: ~30s setup + up to ~9 min for the actual CI job) - real CI
 * job durations observed in this repo's own history (Preflight P0 study) are 46s-115s post-
 * stabilization, so this has wide headroom without being unbounded.
 */
async function startEphemeralRunner(env: RunnerEnv, sandboxId: string, params: { owner: string; repo: string; token: string; labels: string }): Promise<{ success: boolean; log: string }> {
  // sleepAfter 3m (was 12m): the container application holds at most 5 instances, and an instance
  // that idles for 12 minutes after its job is capacity the next job cannot get (2026-09-05, step 4).
  const sandbox = getSandbox(env.GITHUB_RUNNER, sandboxId, { enableDefaultSession: false, keepAlive: false, sleepAfter: "3m", transport: "rpc" });
  const runnerName = `cf-${sandboxId}`.slice(0, 64); // sandboxId is always unique per job/drain-request already - no more $HOSTNAME collision risk (the original root cause of the 2026-08-21 incident this replaces)
  const script = [
    "set -e",
    "cd /tmp",
    `curl -fsSL -o runner.tar.gz "${RUNNER_DOWNLOAD_URL}"`,
    "mkdir -p runner && tar xzf runner.tar.gz -C runner",
    "cd runner",
    "./bin/installdependencies.sh",
    "export RUNNER_ALLOW_RUNASROOT=1",
    `./config.sh --url "https://github.com/${params.owner}/${params.repo}" --token "${params.token}" --name "${runnerName}" --labels "${params.labels}" --ephemeral --disableupdate --unattended`,
    "./run.sh",
  ].join(" && ");

  const exec = await sandbox.exec(script, { timeout: 10 * 60_000 });
  await sandbox.destroy().catch((err) => console.log("github-runner: sandbox.destroy() failed (non-fatal, sleepAfter backstop applies)", String(err)));
  return { success: exec.success, log: `${exec.stdout}\n${exec.stderr}`.slice(-15_000) };
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

  // ?delivery=drain:<installationId>:<owner/repo>:<count> - start N fresh runner instances, each of
  // which claims one queued job (oldest first, GitHub's choice). Recovery tool for a starved queue:
  // jobs whose original queued-webhook instance died never get another one, because GitHub does not
  // re-deliver workflow_job.queued for them. Runs synchronously now (not backgrounded) since the
  // caller of this diagnostic route is a human waiting for a direct answer, not GitHub's webhook
  // 10s-response budget.
  if (deliveryId && deliveryId.startsWith("drain:")) {
    const [, installationId, repoFull, countRaw] = deliveryId.split(":");
    const count = Math.max(1, Math.min(5, Number.parseInt(countRaw ?? "1", 10) || 1));
    if (!installationId || !/^\d+$/.test(installationId) || !repoFull || !/^[\w.-]+\/[\w.-]+$/.test(repoFull)) {
      return Response.json({ ok: false, error: "expected drain:<installationId>:<owner/repo>:<count>" }, { status: 400 });
    }
    const [owner, repo] = repoFull.split("/");
    const started: Array<{ sandboxId: string; success: boolean }> = [];
    for (let i = 0; i < count; i++) {
      const token = await mintRegistrationToken(env, owner!, repo!, Number(installationId));
      const sandboxId = `drain-${crypto.randomUUID().slice(0, 8)}`;
      const result = await startEphemeralRunner(env, sandboxId, { owner: owner!, repo: repo!, token, labels: CLAIM_LABELS.join(",") });
      started.push({ sandboxId, success: result.success });
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
    const body = (await runsRes.json()) as { workflow_runs?: Array<{ id: number; status: string; conclusion: string | null; created_at: string; updated_at: string }> };
    return Response.json({ ok: true, runs: body.workflow_runs ?? [] });
  }

  // ?delivery=installations - lists every installation of this App with its OWN currently-granted
  // permissions (distinct from /app's own permissions, which is the App's declared CEILING, not what
  // any specific installation has actually been granted - added while diagnosing a real 403 on
  // /repos/.../commits after adding "Contents: Read-only" to the App's manifest: GitHub does not
  // auto-propagate a permission increase to existing installations, the installation owner must
  // separately approve it, and this route is how to check whether that approval has actually landed).
  if (deliveryId === "installations") {
    const res = await fetch("https://api.github.com/app/installations", { headers });
    if (!res.ok) return Response.json({ ok: false, error: `installations fetch failed (${res.status})` }, { status: 502 });
    const installations = (await res.json()) as Array<{ id: number; account: { login: string }; permissions: Record<string, string> }>;
    return Response.json({ ok: true, installations: installations.map((i) => ({ id: i.id, account: i.account.login, permissions: i.permissions })) });
  }

  // No delivery param - App-level metadata + recent webhook deliveries.
  const [appRes, deliveriesRes] = await Promise.all([
    fetch("https://api.github.com/app", { headers }),
    fetch("https://api.github.com/app/hook/deliveries?per_page=15", { headers }),
  ]);
  const app = appRes.ok ? await appRes.json() : `app fetch failed (${appRes.status})`;
  let deliveries: unknown = deliveriesRes.ok ? await deliveriesRes.json() : `deliveries fetch failed (${deliveriesRes.status})`;
  if (deliveryId) {
    const specificRes = await fetch(`https://api.github.com/app/hook/deliveries/${deliveryId}`, { headers });
    deliveries = specificRes.ok ? await specificRes.json() : `delivery ${deliveryId} fetch failed (${specificRes.status})`;
  }
  return Response.json({ ok: true, app, deliveries, workerOrigin });
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

/**
 * Webhook handler (2026-09-05, repair step 4): records the lifecycle stage every delivery represents
 * and, for `queued`, enqueues the dispatch. It never runs the runner itself - that was the
 * ctx.waitUntil() path the live tail showed being cancelled at 29.6 s with no record of the outcome.
 * `in_progress` and `completed` deliveries are the assignment and execution provenance: GitHub tells
 * us which runner actually took the job, which is how an unpinned runner serving a different job than
 * the one it was spawned for becomes visible instead of inferred.
 */
async function handleWorkflowJob(event: WorkflowJobEvent, env: RunnerEnv): Promise<void> {
  console.log("github-runner: received workflow_job", event.action, event.workflow_job?.labels);
  const labels = event.workflow_job.labels ?? [];
  if (!jobAddressedToFleet(labels)) {
    console.log("github-runner: labels didn't match, ignoring", labels);
    return; // not addressed to this fleet
  }
  const owner = event.repository.owner.login;
  const repo = event.repository.name;
  const repository = `${owner}/${repo}`;
  const installationId = event.installation?.id ?? (env.GITHUB_APP_INSTALLATION_ID ? Number(env.GITHUB_APP_INSTALLATION_ID) : undefined);
  if (!installationId) throw new Error("no installation id on webhook payload and no GITHUB_APP_INSTALLATION_ID fallback set");
  const jobId = event.workflow_job.id;
  const now = new Date().toISOString();
  const store = lifecycleStore(env);
  await store.ensureJob({
    jobId, repository, installationId, workflowRunId: event.workflow_job.run_id, workflowName: event.workflow_job.workflow_name,
    jobName: event.workflow_job.name, labels, pinned: isPinned(labels), at: now,
  });

  if (event.action === "queued") {
    await store.recordQueued(jobId, now);
    await store.appendEvent(jobId, repository, "workflow_queued", `labels=${labels.join(",")} pinned=${isPinned(labels)}`, now);
    const message: DispatchMessage = { jobId, owner, repo, installationId, labels, workflowRunId: event.workflow_job.run_id, source: "webhook" };
    await env.RUNNER_DISPATCH_QUEUE.send(message);
    await store.recordDispatchRequested(jobId, "webhook", now);
    await store.appendEvent(jobId, repository, "dispatch_requested", "webhook", now);
    console.log("github-runner: dispatch enqueued", repository, "job", jobId, "pinned", isPinned(labels));
    return;
  }
  if (event.action === "in_progress") {
    const runnerName = event.workflow_job.runner_name ?? undefined;
    await store.recordAssigned(jobId, runnerName, now);
    await store.appendEvent(jobId, repository, "job_assigned", runnerName ? `runner=${runnerName}` : undefined, now);
    console.log("github-runner: job assigned", repository, "job", jobId, "runner", runnerName ?? "(unknown)");
    return;
  }
  if (event.action === "completed") {
    const conclusion = event.workflow_job.conclusion ?? undefined;
    await store.recordCompleted(jobId, conclusion, now);
    await store.appendEvent(jobId, repository, "execution_completed", conclusion ? `conclusion=${conclusion}` : undefined, now);
    console.log("github-runner: job completed", repository, "job", jobId, "conclusion", conclusion ?? "(unknown)");
  }
}

/**
 * Queue consumer body: the whole runner lifecycle for ONE job, every stage recorded before the next
 * begins. Throws only for a capacity/start failure, so the Queue retries (with the consumer's own
 * delay) up to max_retries - a runner that started and ran is never re-dispatched, whatever its job's
 * conclusion (the completed webhook records that).
 */
async function dispatchFromQueue(msg: DispatchMessage, env: RunnerEnv): Promise<void> {
  const store = lifecycleStore(env);
  const repository = `${msg.owner}/${msg.repo}`;
  const now = () => new Date().toISOString();
  await store.ensureJob({ jobId: msg.jobId, repository, installationId: msg.installationId, workflowRunId: msg.workflowRunId, labels: msg.labels, pinned: isPinned(msg.labels), at: now() });
  const existing = await store.get(msg.jobId);
  if (existing?.executionCompletedAt || existing?.assignedAt) {
    await store.appendEvent(msg.jobId, repository, "dispatch_started", `skipped: already ${existing.executionCompletedAt ? "completed" : "assigned"}`, now());
    return;
  }
  if (existing && existing.containerStartedAt && !existing.disposition && Date.now() - Date.parse(existing.containerStartedAt) < STALE_DISPATCH_MS) {
    await store.appendEvent(msg.jobId, repository, "dispatch_started", "skipped: a container for this job is already in flight", now());
    return;
  }
  const { attempts } = await store.recordDispatchStarted(msg.jobId, now());
  await store.appendEvent(msg.jobId, repository, "dispatch_started", `attempt=${attempts} source=${msg.source}`, now());
  if (attempts > MAX_DISPATCH_ATTEMPTS) {
    await store.recordDisposition(msg.jobId, "start-failed", `gave up after ${attempts - 1} attempts`, now());
    await store.appendEvent(msg.jobId, repository, "dispatch_failed", `attempt cap ${MAX_DISPATCH_ATTEMPTS} reached`, now());
    return;
  }

  let token: string;
  try {
    token = await mintRegistrationToken(env, msg.owner, msg.repo, msg.installationId);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await store.recordDisposition(msg.jobId, "token-failed", message, now());
    await store.appendEvent(msg.jobId, repository, "dispatch_failed", `token: ${message.slice(0, 300)}`, now());
    throw error; // retryable
  }
  await store.recordTokenMinted(msg.jobId, now());
  await store.appendEvent(msg.jobId, repository, "token_minted", undefined, now());

  // Pinned jobs register with their job-unique label so GitHub can only assign THIS job; legacy
  // plain-label jobs (the backlog) register with the plain labels and take GitHub's oldest match.
  const labels = registrationLabels(msg.labels.length > 0 ? msg.labels : [...CLAIM_LABELS]);
  const sandboxId = `job-${msg.jobId}${attempts > 1 ? `-a${attempts}` : ""}`;
  const runnerName = `cf-${sandboxId}`.slice(0, 64);
  await store.recordContainerStarted(msg.jobId, runnerName, now());
  await store.appendEvent(msg.jobId, repository, "container_started", `runner=${runnerName} labels=${labels.join(",")}`, now());
  let result: { success: boolean; log: string };
  try {
    result = await startEphemeralRunner(env, sandboxId, { owner: msg.owner, repo: msg.repo, token, labels: labels.join(",") });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const disposition = classifyStartError(message);
    await store.recordDisposition(msg.jobId, disposition, message, now());
    await store.appendEvent(msg.jobId, repository, "dispatch_failed", `${disposition}: ${message.slice(0, 300)}`, now());
    console.log(`github-runner: job ${msg.jobId} container start failed (${disposition}): ${message.slice(0, 300)}`);
    throw error; // retryable - the Queue's retry delay gives the container application time to free a slot
  }
  await store.recordDisposition(msg.jobId, result.success ? "exec-succeeded" : "exec-failed", result.success ? undefined : result.log.slice(-2000), now());
  await store.appendEvent(msg.jobId, repository, "runner_disposed", result.success ? "exec-succeeded" : `exec-failed: ${result.log.slice(-300)}`, now());
  console.log(`github-runner: sandbox exec resolved for job ${msg.jobId}, success=${result.success}`);
  if (!result.success) console.log(`github-runner: job ${msg.jobId} runner log tail:\n${result.log}`);
}

/**
 * Reconciler (cron, every 5 minutes): GitHub never re-delivers workflow_job.queued, so a job whose
 * dispatch was lost (cancelled consumer, container ceiling, dropped delivery) used to wait 24 h and be
 * cancelled. Lists GitHub's queued runs per known repository, joins them with the lifecycle rows, and
 * re-enqueues what runner-dispatch.ts decides - bounded by the container application's remaining
 * capacity so a starved queue cannot itself exhaust the fleet.
 */
async function reconcileQueuedJobs(env: RunnerEnv): Promise<{ repositories: number; queued: number; enqueued: number; inFlight: number }> {
  const store = lifecycleStore(env);
  const repositories = await store.listRepositories();
  const nowIso = new Date().toISOString();
  const inFlight = await store.countInFlight(new Date(Date.now() - STALE_DISPATCH_MS).toISOString());
  const capacity = Math.max(0, 4 - inFlight); // max_instances 5, keep one slot for a live webhook dispatch
  let queuedTotal = 0;
  let enqueued = 0;
  for (const { repository, installationId } of repositories) {
    if (capacity - enqueued <= 0) break;
    const [owner, repo] = repository.split("/");
    if (!owner || !repo) continue;
    let queued: QueuedJobView[] = [];
    try {
      const appJwt = await signAppJwt({ appId: env.GITHUB_APP_ID, privateKeyPkcs8Pem: env.GITHUB_APP_PRIVATE_KEY });
      const installationToken = await exchangeInstallationToken(appJwt, String(installationId));
      const headers = { Authorization: `token ${installationToken.token}`, Accept: "application/vnd.github+json", "User-Agent": "diffci-github-runner" };
      const runsRes = await fetch(`https://api.github.com/repos/${repository}/actions/runs?status=queued&per_page=30`, { headers });
      if (!runsRes.ok) throw new Error(`queued runs fetch failed (${runsRes.status})`);
      const runs = ((await runsRes.json()) as { workflow_runs?: Array<{ id: number }> }).workflow_runs ?? [];
      for (const run of runs) {
        const jobsRes = await fetch(`https://api.github.com/repos/${repository}/actions/runs/${run.id}/jobs?per_page=50`, { headers });
        if (!jobsRes.ok) continue;
        const jobs = ((await jobsRes.json()) as { jobs?: Array<{ id: number; status: string; labels?: string[]; created_at: string }> }).jobs ?? [];
        for (const job of jobs) {
          if (job.status !== "queued") continue;
          queued.push({ jobId: job.id, workflowRunId: run.id, labels: job.labels ?? [], queuedAt: job.created_at });
        }
      }
    } catch (error: unknown) {
      console.log(`github-runner: reconcile ${repository}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    queuedTotal += queued.length;
    const views = await store.viewsFor(queued.map((q) => q.jobId));
    const decisions = decideReconcileDispatches(queued, views, nowIso, capacity - enqueued);
    for (const d of decisions) {
      const job = queued.find((q) => q.jobId === d.jobId)!;
      await store.ensureJob({ jobId: job.jobId, repository, installationId, workflowRunId: job.workflowRunId, labels: job.labels, pinned: isPinned(job.labels), at: nowIso });
      await env.RUNNER_DISPATCH_QUEUE.send({ jobId: job.jobId, owner, repo, installationId, labels: job.labels, workflowRunId: job.workflowRunId, source: "reconcile" });
      await store.recordDispatchRequested(job.jobId, "reconcile", nowIso);
      await store.appendEvent(job.jobId, repository, "dispatch_requested", `reconcile: ${d.reason}`, nowIso);
      enqueued++;
    }
  }
  console.log(`github-runner: reconcile ${JSON.stringify({ repositories: repositories.length, queued: queuedTotal, enqueued, inFlight })}`);
  return { repositories: repositories.length, queued: queuedTotal, enqueued, inFlight };
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
    // 2026-09-05 (repair step 4): lifecycle provenance. ?repository=owner/name&limit=N lists recent
    // jobs; ?job=<id> returns one job's row and its full stage trail. ?reconcile=1 runs the reconciler
    // now (same code as the cron) and returns its summary - the qualification tool for the step-4
    // success condition, never a dispatch by itself.
    if (url.pathname === "/lifecycle" && request.method === "GET") {
      const auth = request.headers.get("Authorization") ?? "";
      if (!env.RUNNER_DISPATCH_TOKEN || auth !== `Bearer ${env.RUNNER_DISPATCH_TOKEN}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const store = lifecycleStore(env);
      if (url.searchParams.get("reconcile") === "1") return Response.json({ ok: true, reconcile: await reconcileQueuedJobs(env) });
      const jobParam = url.searchParams.get("job");
      if (jobParam && /^\d+$/.test(jobParam)) {
        const jobId = Number(jobParam);
        return Response.json({ ok: true, job: (await store.get(jobId)) ?? null, events: await store.listEvents(jobId) });
      }
      const repository = url.searchParams.get("repository") ?? undefined;
      const limit = Math.max(1, Math.min(100, Number.parseInt(url.searchParams.get("limit") ?? "20", 10) || 20));
      return Response.json({ ok: true, jobs: await store.listRecent(repository, limit) });
    }
    // Internal token-proxy route (Preflight P1 Part M): diffci-preflight has no GitHub App credentials
    // of its own - deliberately, to avoid duplicating a private key across two Workers - and instead
    // requests a real installation token from THIS Worker, the one already holding those credentials.
    // Same auth (RUNNER_DISPATCH_TOKEN) and same real signAppJwt/exchangeInstallationToken path
    // mintRegistrationToken/runnerAppInfo already use - no new credential surface, only a new caller.
    if (url.pathname === "/installation-token" && request.method === "GET") {
      const auth = request.headers.get("Authorization") ?? "";
      if (!env.RUNNER_DISPATCH_TOKEN || auth !== `Bearer ${env.RUNNER_DISPATCH_TOKEN}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const installationId = url.searchParams.get("installationId");
      if (!installationId || !/^\d+$/.test(installationId)) return Response.json({ ok: false, error: "installationId is required" }, { status: 400 });
      const appJwt = await signAppJwt({ appId: env.GITHUB_APP_ID, privateKeyPkcs8Pem: env.GITHUB_APP_PRIVATE_KEY });
      const installationToken = await exchangeInstallationToken(appJwt, installationId);
      return Response.json({ ok: true, token: installationToken.token, expiresAt: installationToken.expiresAt });
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
    void ctx; // the dispatch no longer runs in waitUntil - see handleWorkflowJob
    await handleWorkflowJob(event, env);
    return new Response("accepted", { status: 202 });
  },

  /** Queue consumer (wrangler.github-runner.jsonc "queues.consumers"): one runner lifecycle per message; a
   * batch's messages - the jobs of one push - run concurrently (runner-dispatch.ts consumeDispatchBatch). */
  async queue(batch: { messages: DispatchQueueMessage[] }, env: RunnerEnv): Promise<void> {
    await consumeDispatchBatch(batch.messages, (message) => dispatchFromQueue(message, env), (line) => console.log(line));
  },

  /** Cron (wrangler.github-runner.jsonc "triggers.crons"): the reconciler safety net. */
  async scheduled(_event: unknown, env: RunnerEnv, ctx: ExecutionCtx): Promise<void> {
    ctx.waitUntil(reconcileQueuedJobs(env).catch((error: unknown) => console.log(`github-runner: reconcile failed: ${error instanceof Error ? error.message : String(error)}`)));
  },
};
