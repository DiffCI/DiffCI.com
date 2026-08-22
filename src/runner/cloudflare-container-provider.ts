/**
 * RunnerProvider #1 (Part 15/16): real Cloudflare Containers, talking to the deployed
 * diffci-synthetic-runner Worker (src/runner/cloudflare/synthetic-runner-worker.ts) over its HTTP
 * control surface. Provider-specific details (the Worker's base URL, the control-token auth scheme, the
 * single-call execute/timings/result JSON shape) are fully contained in this one file - the generic
 * RunnerProvider interface (src/runner/provider.ts) and everything that consumes it never see a
 * Cloudflare-specific type (Part 16).
 *
 * The underlying Worker's /v1/runner/execute is synchronous end-to-end (provision -> ready -> exec ->
 * destroy, all in one call - see that Worker's header comment for why), so provisionRunner() here does
 * the ENTIRE real lifecycle in one await and returns status "ready" with the full result already
 * attached in providerMetadata; getRunnerStatus() and terminateRunner() are then correctly idempotent
 * no-ops against an already-completed/already-torn-down runner (Part 13's contract is honored, not
 * violated - "ready" and "terminated" are both real, already-true facts by the time they're reported).
 *
 * `resourceClass` from RunnerRequest is ignored by this provider (Cloudflare Containers' instance sizing
 * is a deploy-time wrangler config, not a per-request parameter).
 */
import type { RunnerProvider } from "./provider.js";
import type { RunnerInstance, RunnerRequest, RunnerStatusResult } from "./types.js";

export interface CloudflareContainerProviderConfig {
  workerBaseUrl: string; // e.g. https://diffci-synthetic-runner.<account>.workers.dev
  controlToken: string;
  /** The synthetic job command to run - Part 19's example is a literal `echo`. Provided by the caller. */
  jobCommand: string;
}

export interface CloudflareRunTimings {
  provisionStartedAt: number;
  readyAt: number;
  completedAt: number;
  terminatedAt?: number;
}

export function createCloudflareContainerRunnerProvider(config: CloudflareContainerProviderConfig, fetchFn: typeof fetch = fetch): RunnerProvider {
  // Completed results are cached here keyed by providerRunnerId - the caller (getRunnerStatus) reads a
  // result that has already fully happened; no persistence beyond this provider instance's own lifetime
  // is needed since Part 19's synthetic proof calls provisionRunner then immediately reads the return
  // value / one follow-up status check within the same run.
  const completed = new Map<string, RunnerStatusResult>();

  return {
    name: "cloudflare-containers",

    async provisionRunner(request: RunnerRequest): Promise<RunnerInstance> {
      const providerRunnerId = `synth-${crypto.randomUUID()}`;
      const res = await fetchFn(`${config.workerBaseUrl}/v1/runner/execute`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.controlToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ runnerId: providerRunnerId, jobCommand: config.jobCommand }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Cloudflare Containers execute failed: HTTP ${res.status} ${text.slice(0, 300)}`);
      }
      const body = (await res.json()) as { runnerId: string; result: unknown; timings: CloudflareRunTimings };
      const status: RunnerStatusResult = { status: "ready", providerMetadata: { result: body.result, timings: body.timings } };
      completed.set(providerRunnerId, status);
      return { providerRunnerId, status: "ready", providerMetadata: status.providerMetadata };
    },

    async getRunnerStatus(providerRunnerId: string): Promise<RunnerStatusResult> {
      return completed.get(providerRunnerId) ?? { status: "terminated" }; // unknown id (never provisioned by THIS provider instance, or already gc'd) - report gone, never throw
    },

    async terminateRunner(_providerRunnerId: string): Promise<void> {
      // No-op by design (Part 13 idempotent contract) - the underlying container was already destroyed
      // inside the synchronous /v1/runner/execute call. Nothing left to tear down.
    },
  };
}
