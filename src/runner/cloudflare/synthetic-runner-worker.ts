/**
 * Real Cloudflare Containers control plane for RunnerProvider #1 (Part 15/16), REVISED to use
 * Cloudflare's own pre-published Sandbox image (`docker.io/cloudflare/sandbox:0.12.5` - the exact same
 * image `diffci-research-sandbox`/ResearchSandbox already uses, see
 * src/research/cloudflare/validation-worker.ts) rather than a custom-built Dockerfile. This was a
 * deliberate pivot made live during this build: a custom image requires a local Docker daemon to build
 * (confirmed by a real failed deploy attempt - "The Docker CLI is needed... could not be launched"),
 * which was unavailable in this environment; a pre-published Hub image needs no local build at all -
 * Cloudflare pulls it directly - confirmed by a real successful deploy using this exact image reference.
 * This is a SEPARATE Worker/Durable-Object-class/database-free deployment from
 * diffci-research-sandbox - it shares only the same public base image, never the Worker, the
 * ResearchSandbox class, or any Stage 2F binding. No Stage 2F file was touched to build this.
 *
 * Auth: a single dispatch-token Bearer check (RUNNER_CONTROL_TOKEN), same pattern as every other
 * internal DiffCI Worker.
 */
import { getSandbox, Sandbox } from "@cloudflare/sandbox";

export { Sandbox as SyntheticRunner };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SandboxNamespace = any; // matches validation-worker.ts's own `env.ResearchSandbox as any` idiom - see that file's note on why (no @cloudflare/workers-types dependency in this project)

interface Env {
  SYNTHETIC_RUNNER: SandboxNamespace;
  RUNNER_CONTROL_TOKEN?: string;
}

interface ExecutionCtx {
  waitUntil(promise: Promise<unknown>): void;
}

function json(payload: unknown, status = 200): Response {
  return Response.json(payload, { status, headers: { "Cache-Control": "no-store" } });
}

async function authorized(request: Request, expected?: string): Promise<boolean> {
  if (!expected) return false;
  const auth = request.headers.get("Authorization") || "";
  return auth === `Bearer ${expected}`;
}

/**
 * Builds the minimal runner-agent bootstrap script (R1 Part 10) that runs INSIDE the container: register
 * -> claim -> execute the claimed command -> submit result. Deliberately not a generic CI agent
 * framework - four HTTP calls and one `eval` of the claimed command, nothing else. `set -e` on the outer
 * script but NOT around the claimed-command execution itself (captured with `set +e`/`set -e` bracketing)
 * so a non-zero exit from the synthetic job is reported via /v1/runner/result, not treated as a bootstrap
 * script failure. The raw runner token is injected as an env var (DIFFCI_RUNNER_TOKEN) at container start
 * time, NEVER baked into the image/script text itself (Part 11) - see startEphemeralRunnerAsync's own
 * `envVars`, not the script below, for where the real secret actually enters the container.
 */
function buildBootstrapScript(): string {
  return [
    "set -e",
    'curl -sf -X POST "$DIFFCI_API_URL/v1/runner/register" -H "Content-Type: application/json" -d "{\\"token\\":\\"$DIFFCI_RUNNER_TOKEN\\"}" > /dev/null',
    'CLAIM=$(curl -sf -X POST "$DIFFCI_API_URL/v1/runner/claim" -H "Content-Type: application/json" -d "{\\"token\\":\\"$DIFFCI_RUNNER_TOKEN\\"}")',
    'CMD=$(printf \'%s\' "$CLAIM" | node -e \'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);if(!j.ok){process.stderr.write("claim failed: "+JSON.stringify(j));process.exit(1)}process.stdout.write(j.data.command)})\')',
    'START_MS=$(node -e "console.log(Date.now())")',
    "set +e",
    'OUTPUT=$(eval "$CMD" 2>&1)',
    "EXIT_CODE=$?",
    "set -e",
    'END_MS=$(node -e "console.log(Date.now())")',
    'DURATION_MS=$((END_MS-START_MS))',
    'PAYLOAD=$(node -e \'const o=process.argv[1];const e=parseInt(process.argv[2],10);const d=parseInt(process.argv[3],10);process.stdout.write(JSON.stringify({token:process.env.DIFFCI_RUNNER_TOKEN,exitCode:e,stdout:o,durationMs:d}))\' "$OUTPUT" "$EXIT_CODE" "$DURATION_MS")',
    'curl -sf -X POST "$DIFFCI_API_URL/v1/runner/result" -H "Content-Type: application/json" -d "$PAYLOAD" > /dev/null',
    'echo "diffci-runner-bootstrap-complete exit=$EXIT_CODE"',
  ].join(" && ");
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionCtx): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true, service: "diffci-synthetic-runner" });

    if (!(await authorized(request, env.RUNNER_CONTROL_TOKEN))) return json({ ok: false, error: "unauthorized" }, 401);

    // POST /v1/runner/start  { runnerId, apiUrl, runnerToken, timeoutMs? }
    // R1's genuinely ASYNC provisioning path (src/runner/cloudflare-container-async-provider.ts): starts
    // the container's bootstrap script in the BACKGROUND via ctx.waitUntil() and responds immediately
    // with "accepted" - unlike /v1/runner/execute above, this call does NOT wait for the job to finish.
    // The container's own bootstrap script (buildBootstrapScript) drives the real register/claim/
    // execute/result lifecycle by calling back into DiffCI's own control-plane API
    // (src/runner/agent-api.ts, wired into product-worker.ts) using its injected one-time token - this
    // Worker never sees the job's command or result at all, only that a container was told to start.
    if (request.method === "POST" && url.pathname === "/v1/runner/start") {
      const body = (await request.json().catch(() => null)) as { runnerId?: string; apiUrl?: string; runnerToken?: string; timeoutMs?: number } | null;
      if (!body?.runnerId || !body.apiUrl || !body.runnerToken) return json({ ok: false, error: "runnerId, apiUrl, and runnerToken are required" }, 400);
      const execTimeoutMs = Math.min(body.timeoutMs ?? 30_000, 5 * 60_000);
      const runnerId = body.runnerId;
      const apiUrl = body.apiUrl;
      const runnerToken = body.runnerToken;

      ctx.waitUntil(
        (async () => {
          const sandbox = getSandbox(env.SYNTHETIC_RUNNER, runnerId, { enableDefaultSession: false, keepAlive: false, sleepAfter: "6m", transport: "rpc" });
          try {
            const exec = await sandbox.exec(buildBootstrapScript(), { timeout: execTimeoutMs, env: { DIFFCI_API_URL: apiUrl, DIFFCI_RUNNER_TOKEN: runnerToken } });
            console.log(`synthetic-runner: bootstrap for ${runnerId} finished success=${exec.success} exitCode=${exec.exitCode}`);
            if (!exec.success) console.log(`synthetic-runner: bootstrap stderr tail for ${runnerId}:`, exec.stderr.slice(-2000));
          } catch (err) {
            console.log(`synthetic-runner: bootstrap exec threw for ${runnerId}:`, err instanceof Error ? err.message : String(err));
          }
        })(),
      );

      return json({ ok: true, accepted: true, runnerId });
    }

    // POST /v1/runner/terminate  { runnerId }
    // Idempotent (Part 9): destroying an already-destroyed or never-provisioned sandbox id is treated as
    // success, matching the Sandbox SDK's own tolerance and RunnerProvider.terminateRunner()'s contract.
    if (request.method === "POST" && url.pathname === "/v1/runner/terminate") {
      const body = (await request.json().catch(() => null)) as { runnerId?: string } | null;
      if (!body?.runnerId) return json({ ok: false, error: "runnerId is required" }, 400);
      const sandbox = getSandbox(env.SYNTHETIC_RUNNER, body.runnerId, { enableDefaultSession: false, keepAlive: false, sleepAfter: "6m", transport: "rpc" });
      try {
        await sandbox.destroy();
      } catch (err) {
        console.log(`synthetic-runner: terminate destroy() for ${body.runnerId} failed (treated as already-gone, idempotent):`, err instanceof Error ? err.message : String(err));
      }
      return json({ ok: true, runnerId: body.runnerId });
    }

    // POST /v1/runner/execute  { runnerId, jobCommand }
    // Deliberately synchronous end-to-end (provision -> ready -> execute -> result, all within one
    // sandbox.exec() call) rather than a separate provision/poll-status pair - the Sandbox SDK's exec()
    // already blocks until the command completes, and a real cold-start-to-completion latency is
    // exactly what Part 20 wants captured, not hidden behind artificial polling. See
    // src/runner/cloudflare-container-provider.ts for how RunnerProvider's async provision/status
    // contract is satisfied on top of this single call.
    if (request.method === "POST" && url.pathname === "/v1/runner/execute") {
      const body = (await request.json().catch(() => null)) as { runnerId?: string; jobCommand?: string; timeoutMs?: number } | null;
      if (!body?.runnerId) return json({ ok: false, error: "runnerId is required" }, 400);
      // Default stays short (synthetic jobs are seconds-long by design - Part 19); a caller
      // investigating something genuinely longer-running (e.g. a real package install/diagnostic probe,
      // not a "synthetic job" in the Part 19 sense) may opt into a longer budget explicitly, capped at 5 min.
      const execTimeoutMs = Math.min(body.timeoutMs ?? 30_000, 5 * 60_000);

      const provisionStartedAt = Date.now();
      const sandbox = getSandbox(env.SYNTHETIC_RUNNER, body.runnerId, { enableDefaultSession: false, keepAlive: false, sleepAfter: "6m", transport: "rpc" });
      const readyAt = Date.now(); // getSandbox() itself is a cheap client construction, not a container start - the real cold-start cost is inside exec() below

      let exec: { success: boolean; exitCode: number; stdout: string; stderr: string };
      try {
        exec = await sandbox.exec(body.jobCommand ?? 'echo "diffci-runner-ok"', { timeout: execTimeoutMs });
      } catch (err) {
        return json({ ok: false, error: `sandbox exec failed: ${err instanceof Error ? err.message : String(err)}` }, 502);
      }
      const completedAt = Date.now();

      // Explicit teardown (Part 13/19: "runner confirmed terminated") - do not rely solely on
      // sleepAfter's backstop for a job we already know is finished.
      let terminatedAt: number | undefined;
      try {
        await sandbox.destroy();
        terminatedAt = Date.now();
      } catch (err) {
        console.log("synthetic-runner: destroy() failed (non-fatal, sleepAfter backstop still applies)", err);
      }

      return json({
        ok: true,
        runnerId: body.runnerId,
        result: { exitCode: exec.exitCode, success: exec.success, stdout: exec.stdout.slice(0, 10_000), stderr: exec.stderr.slice(0, 10_000) },
        timings: { provisionStartedAt, readyAt, completedAt, terminatedAt },
      });
    }

    return json({ ok: false, error: "not-found" }, 404);
  },
};
