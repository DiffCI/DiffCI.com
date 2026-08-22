/**
 * The runner-provider boundary (Part 11). Callers (the execution-queue scheduler, product API runner
 * routes) depend only on this interface - a concrete provider (mock, or a future Cloudflare-Containers/
 * AWS/GCP implementation) is swapped in at wiring time only.
 */
import type { RunnerInstance, RunnerRequest, RunnerStatusResult } from "./types.js";

export interface RunnerProvider {
  readonly name: string;
  provisionRunner(request: RunnerRequest): Promise<RunnerInstance>;
  getRunnerStatus(providerRunnerId: string): Promise<RunnerStatusResult>;
  /** Must be idempotent (Part 13/15) - terminating an already-terminated (or unknown) runner must not
   * throw. */
  terminateRunner(providerRunnerId: string): Promise<void>;
}
