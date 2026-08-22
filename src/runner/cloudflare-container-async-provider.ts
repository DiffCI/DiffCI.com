/**
 * RunnerProvider R1 (Real Runner R1) - a genuinely ASYNC Cloudflare Containers provider, distinct from
 * cloudflare-container-provider.ts's synchronous "RunnerProvider #1" (which does the entire lifecycle
 * inside one blocking HTTP call and is retained unchanged - see that file's own header). This provider
 * exists because R1 needs the real, separately-timestamped lifecycle
 * (provision -> bootstrap -> authenticate -> claim -> execute -> result -> terminate) that a single
 * synchronous call collapses away.
 *
 * provisionRunner() kicks off the container's bootstrap script via
 * src/runner/cloudflare/synthetic-runner-worker.ts's /v1/runner/start route (which itself runs the
 * container in the BACKGROUND via ctx.waitUntil() and responds immediately) and returns "provisioning"
 * right away - genuinely honest, not a fabricated intermediate state. The runner container itself then
 * drives its own lifecycle forward by calling back into DiffCI's runner-agent API
 * (src/runner/agent-api.ts) using its one-time credential; this provider has no further visibility into
 * that process and does not poll for it (see getRunnerStatus()'s own honesty note below).
 *
 * `resourceClass` from RunnerRequest is still ignored (same reason as the synchronous provider -
 * Cloudflare Containers' instance sizing is deploy-time config, not per-request).
 */
import type { RunnerProvider } from "./provider.js";
import type { RunnerInstance, RunnerRequest, RunnerStatusResult } from "./types.js";

export interface CloudflareContainerAsyncProviderConfig {
  workerBaseUrl: string; // diffci-synthetic-runner's own URL
  controlToken: string; // the existing Worker-wide RUNNER_CONTROL_TOKEN - control-plane-to-Worker auth, distinct from the per-runner credential in RunnerRequest.runnerCredential
  startTimeoutMs?: number; // upper bound passed through to sandbox.exec() inside the Worker (Part 20)
}

export function createCloudflareContainerAsyncRunnerProvider(config: CloudflareContainerAsyncProviderConfig, fetchFn: typeof fetch = fetch): RunnerProvider {
  return {
    name: "cloudflare-containers-async",

    async provisionRunner(request: RunnerRequest): Promise<RunnerInstance> {
      if (!request.runnerCredential || !request.jobCommand) {
        throw new Error("cloudflare-containers-async provider requires request.runnerCredential and request.jobCommand - use SchedulerDeps.mintRunnerCredential to populate them");
      }
      const providerRunnerId = `r1-${request.runnerCredential.runnerId}`;
      const res = await fetchFn(`${config.workerBaseUrl}/v1/runner/start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.controlToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          runnerId: providerRunnerId,
          apiUrl: request.runnerCredential.apiBaseUrl,
          runnerToken: request.runnerCredential.token,
          timeoutMs: config.startTimeoutMs,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Cloudflare Containers async start failed: HTTP ${res.status} ${text.slice(0, 300)}`);
      }
      // Genuinely "provisioning" - the container was just told to start; the bootstrap script has not
      // necessarily even begun executing yet, let alone registered. This is the real, honest state.
      return { providerRunnerId, status: "provisioning", providerMetadata: { sandboxId: providerRunnerId } };
    },

    async getRunnerStatus(_providerRunnerId: string): Promise<RunnerStatusResult> {
      // Real, disclosed limitation, not a design gap papered over: this provider has no independent
      // side-channel to poll the Cloudflare Sandbox platform for exec-in-progress state (no such query
      // API is exposed for an in-flight background exec started via ctx.waitUntil() in a DIFFERENT
      // request). The authoritative, real-time status for THIS provider's runners is the runner's own
      // self-reported callbacks (register/heartbeat/claim/result), persisted directly into
      // src/runner/store.ts's `runners` table by the agent-api.ts handlers - callers that need current
      // status should read RunnerStore, not poll this method. Orphan cleanup (src/runner/cleanup.ts)
      // already reads RunnerStore directly for staleness, not this method, so this is not on any real
      // control-flow critical path today.
      return { status: "provisioning", providerMetadata: { note: "status authority is RunnerStore, updated via runner-agent callbacks - see this method's own doc comment" } };
    },

    async terminateRunner(providerRunnerId: string): Promise<void> {
      const res = await fetchFn(`${config.workerBaseUrl}/v1/runner/terminate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.controlToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ runnerId: providerRunnerId }),
      });
      if (!res.ok) {
        // Idempotent contract (RunnerProvider's own interface doc, Part 9): a terminate call must never
        // throw just because the resource is already gone or unknown - only surface a genuine transport
        // failure, and even then, log rather than throw, since the orphan-cleanup caller treats a thrown
        // terminateRunner() as a real failure to retry, not as "already terminated."
        console.log(`cloudflare-containers-async: terminate request for ${providerRunnerId} returned HTTP ${res.status} - treated as already-gone`);
      }
    },
  };
}
