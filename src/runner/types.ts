/** Explicit lifecycle states (Part 13). */
export type RunnerState = "requested" | "provisioning" | "ready" | "assigned" | "busy" | "completed" | "terminating" | "terminated" | "failed";

export interface RunnerRequest {
  organizationId: string;
  repositoryId?: string;
  resourceClass: string; // provider-agnostic label, e.g. "standard-2" - interpreted by the provider impl
  region?: string;
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
}
