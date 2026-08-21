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
  // start()'d - see the Dockerfile's ENTRYPOINT note. sleepAfter is irrelevant for the same reason
  // (the process exits on its own once the one job finishes; there's no idle period to sleep after).
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

interface RunnerEnv {
  GITHUB_RUNNER: DurableObjectNamespace<GithubRunner>;
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  // Single installation id covers both repos IF the App is installed once at the adityankale190895
  // account level with both DiffCI.com and DentalPresence.in selected. If they end up as separate
  // installations, switch this to a per-owner lookup (env.GITHUB_APP_INSTALLATION_ID_<OWNER>) - the
  // webhook payload's `installation.id` (present on every App-sourced delivery) makes that trivial;
  // this constant is only a fallback for manual/local testing without a live delivery.
  GITHUB_APP_INSTALLATION_ID?: string;
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
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`registration-token request failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const body = (await res.json()) as { token: string };
  return body.token;
}

async function handleWorkflowJob(event: WorkflowJobEvent, env: RunnerEnv, ctx: ExecutionContext): Promise<void> {
  if (event.action !== "queued") return; // ignore in_progress/completed - we only ever START runners
  const labels = event.workflow_job.labels ?? [];
  if (!CLAIM_LABELS.every((l) => labels.includes(l))) return; // not addressed to this fleet

  const owner = event.repository.owner.login;
  const repo = event.repository.name;
  const installationId = event.installation?.id ?? (env.GITHUB_APP_INSTALLATION_ID ? Number(env.GITHUB_APP_INSTALLATION_ID) : undefined);
  if (!installationId) throw new Error("no installation id on webhook payload and no GITHUB_APP_INSTALLATION_ID fallback set");

  // Do the actual dispatch in the background: GitHub expects the webhook endpoint to respond within
  // ~10s, and minting a token + starting a container comfortably exceeds that under cold start.
  ctx.waitUntil(
    (async () => {
      const token = await mintRegistrationToken(env, owner, repo, installationId);
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
        },
      });
    })().catch((err) => console.log("github-runner: dispatch failed", err)),
  );
}

export default {
  async fetch(request: Request, env: RunnerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/webhook" || request.method !== "POST") return new Response("not found", { status: 404 });

    // Signature must be verified against the RAW body - read as text first, never parse-then-reserialize.
    const rawBody = await request.text();
    const signature = request.headers.get("X-Hub-Signature-256");
    if (!(await verifyWebhookSignature(rawBody, signature, env.GITHUB_WEBHOOK_SECRET))) {
      return new Response("invalid signature", { status: 401 });
    }

    const eventName = request.headers.get("X-GitHub-Event");
    if (eventName !== "workflow_job") return new Response("ignored", { status: 202 });

    const event = JSON.parse(rawBody) as WorkflowJobEvent;
    await handleWorkflowJob(event, env, ctx);
    return new Response("accepted", { status: 202 });
  },
};
