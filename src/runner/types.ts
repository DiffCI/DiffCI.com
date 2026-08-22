/** Explicit lifecycle states (Part 13). */
export type RunnerState = "requested" | "provisioning" | "ready" | "assigned" | "busy" | "completed" | "terminating" | "terminated" | "failed";

export interface RunnerRequest {
  organizationId: string;
  repositoryId?: string;
  resourceClass: string; // provider-agnostic label, e.g. "standard-2" - interpreted by the provider impl
  region?: string;
  /** R1 (Real Runner) additions - all optional, ignored by providers that don't need them (mock, the
   * original synchronous Cloudflare Containers provider). Populated by the scheduler via an optional
   * SchedulerDeps.mintRunnerCredential hook (src/execution-queue/scheduler.ts) for providers that run a
   * real, separately-authenticating runner AGENT process rather than executing synchronously in one
   * control-plane-initiated call. */
  runnerCredential?: {
    /** DiffCI's own internal Runner.id - lets the agent-API callbacks (register/claim/result) find the
     * right row without trusting anything the runner process claims about its own identity. */
    runnerId: string;
    /** The execution_queue_items id this credential is scoped to - a runner presenting this credential
     * can only ever claim THIS job (Part 12: "must not claim another organization's job"). */
    jobId: string;
    /** Raw, single-use token - only its hash is ever persisted (src/runner/token.ts). */
    token: string;
    /** Base URL of the control-plane API the runner agent calls back into. */
    apiBaseUrl: string;
  };
  /** The trivial, deterministic synthetic command the runner agent should execute once it claims its job
   * (Part 15) - never customer repository code. */
  jobCommand?: string;
}

/** Provider-specific metadata (Part 11: "must remain inside provider implementations where possible")
 * is carried in `providerMetadata` as an opaque bag - callers of RunnerProvider never need to know its
 * shape, only the provider implementation that produced it does. */
export interface RunnerInstance {
  providerRunnerId: string;
  status: RunnerState;
  providerMetadata?: Record<string, unknown>;
}

export interface RunnerStatusResult {
  status: RunnerState;
  providerMetadata?: Record<string, unknown>;
}

/** D1-persisted runner record (Part 14). */
export interface Runner {
  id: string;
  organizationId: string;
  provider: string;
  providerRunnerId?: string;
  status: RunnerState;
  requestedResourceClass: string;
  repositoryId?: string;
  assignedJobId?: string;
  createdAt: string;
  readyAt?: string;
  startedAt?: string;
  completedAt?: string;
  terminatedAt?: string;
  runtimeSeconds?: number;
  costEstimateUsd?: number;
  /** R1 additions. */
  costBasis?: string; // e.g. "provider_estimate" (src/usage/cost-model.ts) - undefined until a real cost is computed
  lastHeartbeatAt?: string;
  failureReason?: string;
}
