/**
 * Runner-agent API boundary (R1 Part 13) - the minimum surface a real ephemeral runner AGENT process
 * calls back into: register, heartbeat, claim, result. Pure, HTTP-framework-free handler functions
 * (product-worker.ts wires these to actual routes) so they're directly unit-testable against real
 * D1-backed stores without spinning up a Worker.
 *
 * Every handler starts by verifying the presented token (src/runner/token.ts) and returns a typed,
 * discriminated result rather than throwing for expected failure modes (unknown/expired/revoked token,
 * wrong job, replay) - callers (the HTTP layer) map these directly to status codes; only genuinely
 * unexpected errors (a store throwing) propagate as real exceptions.
 *
 * Authorization model (R1 Part 12/40): a runner can only ever act on the (runnerId, jobId,
 * organizationId) triple baked into its OWN token at issuance - never anything it claims about itself
 * in the request body. claim() additionally verifies the token's jobId matches the job actually being
 * claimed, so a token minted for job A can never be used to claim job B, and cross-organization access
 * is impossible by construction (the token itself IS the organization scope).
 */
import type { RunnerTokenStore } from "./token.js";
import type { RunnerStore } from "./store.js";
import type { ExecutionQueueStore } from "../execution-queue/store.js";
import type { UsageStore } from "../usage/store.js";
import type { ComputeCostModel } from "../usage/cost-model.js";

export interface AgentApiDeps {
  tokenStore: RunnerTokenStore;
  runnerStore: RunnerStore;
  queueStore: ExecutionQueueStore;
  usageStore: UsageStore;
  costModel: ComputeCostModel;
  /** Injected so tests can assert exact events without a real audit store; product-worker.ts wires this
   * to productStore.recordAuditEvent. Never receives token/credential values (R1 Part 30). */
  recordAuditEvent: (entry: { organizationId: string; action: string; targetType: string; targetId: string; metadata?: Record<string, unknown> }) => Promise<void>;
}

export type AgentApiError = "invalid_token" | "token_expired" | "token_revoked" | "already_claimed" | "runner_not_found" | "job_not_found";

export interface AgentApiResult<T> {
  ok: boolean;
  error?: AgentApiError;
  data?: T;
}

function tokenFailureToError(reason: "not_found" | "expired" | "revoked"): AgentApiError {
  return reason === "not_found" ? "invalid_token" : reason === "expired" ? "token_expired" : "token_revoked";
}

// Output caps (R1 Part 17: "a job must not be able to upload unlimited logs into DiffCI storage").
const MAX_OUTPUT_CHARS = 4_000;

// --- register ----------------------------------------------------------------------------------------

export async function handleRegister(rawToken: string, deps: AgentApiDeps): Promise<AgentApiResult<{ runnerId: string; jobId: string }>> {
  const verified = await deps.tokenStore.verify(rawToken);
  if (!verified.ok) return { ok: false, error: tokenFailureToError(verified.reason) };
  await deps.runnerStore.recordHeartbeat(verified.record.runnerId);
  await deps.recordAuditEvent({ organizationId: verified.record.organizationId, action: "runner.registered", targetType: "runner", targetId: verified.record.runnerId, metadata: { jobId: verified.record.jobId } });
  return { ok: true, data: { runnerId: verified.record.runnerId, jobId: verified.record.jobId } };
}

// --- heartbeat -----------------------------------------------------------------------------------------

export async function handleHeartbeat(rawToken: string, deps: AgentApiDeps): Promise<AgentApiResult<{ runnerId: string }>> {
  const verified = await deps.tokenStore.verify(rawToken);
  if (!verified.ok) return { ok: false, error: tokenFailureToError(verified.reason) };
  await deps.runnerStore.recordHeartbeat(verified.record.runnerId);
  return { ok: true, data: { runnerId: verified.record.runnerId } };
}

// --- claim ---------------------------------------------------------------------------------------------

export interface ClaimResultData {
  runnerId: string;
  jobId: string;
  /** The exact, trivial, deterministic command to execute (R1 Part 15) - sourced from the queue item's
   * own jobReference field (reused as-is, no new column - the smallest change that carries this data). */
  command: string;
}

export async function handleClaim(rawToken: string, deps: AgentApiDeps): Promise<AgentApiResult<ClaimResultData>> {
  const verified = await deps.tokenStore.verify(rawToken);
  if (!verified.ok) return { ok: false, error: tokenFailureToError(verified.reason) };

  const claimed = await deps.tokenStore.markClaimed(rawToken);
  if (!claimed) return { ok: false, error: "already_claimed" }; // Part 28: token replay / wrong (repeat) job claim

  const queueItem = await deps.queueStore.getItem(verified.record.jobId);
  if (!queueItem) return { ok: false, error: "job_not_found" };

  await deps.runnerStore.transitionRunnerStatus(verified.record.runnerId, "busy");
  await deps.runnerStore.recordHeartbeat(verified.record.runnerId);
  await deps.recordAuditEvent({ organizationId: verified.record.organizationId, action: "runner.execution_started", targetType: "runner", targetId: verified.record.runnerId, metadata: { jobId: verified.record.jobId } });

  return { ok: true, data: { runnerId: verified.record.runnerId, jobId: verified.record.jobId, command: queueItem.jobReference } };
}

// --- result ----------------------------------------------------------------------------------------------

export interface SubmitResultInput {
  token: string;
  exitCode: number;
  stdout: string;
  stderr?: string;
  durationMs: number;
}

export interface SubmitResultData {
  runnerId: string;
  jobId: string;
  runtimeSeconds: number;
  costEstimateUsd: number;
  duplicate?: boolean;
}

export async function handleResult(input: SubmitResultInput, deps: AgentApiDeps): Promise<AgentApiResult<SubmitResultData>> {
  const verified = await deps.tokenStore.verify(input.token);
  if (!verified.ok) return { ok: false, error: tokenFailureToError(verified.reason) };

  const runtimeSeconds = Math.max(0, input.durationMs) / 1000;
  const submitted = await deps.tokenStore.markResultSubmitted(input.token);
  if (!submitted) {
    // Part 28: a duplicate result callback is a safe, idempotent no-op - never a second usage event,
    // never a second state transition, never an error the runner needs to handle specially.
    return { ok: true, data: { runnerId: verified.record.runnerId, jobId: verified.record.jobId, runtimeSeconds, costEstimateUsd: 0, duplicate: true } };
  }

  const stdout = input.stdout.slice(0, MAX_OUTPUT_CHARS);
  const stderr = (input.stderr ?? "").slice(0, MAX_OUTPUT_CHARS);
  const cost = deps.costModel.estimateCost({ computeSeconds: runtimeSeconds });

  await deps.runnerStore.transitionRunnerStatus(verified.record.runnerId, "completed", { runtimeSeconds, costEstimateUsd: cost.estimatedUsd, costBasis: cost.basis });

  // Part 29: provider-independent usage, idempotent by construction (recordUsageEventIfNew's own
  // idempotency key + the markResultSubmitted single-use gate above are two independent layers).
  await deps.usageStore.recordUsageEventIfNew({
    organizationId: verified.record.organizationId,
    eventType: "runner_seconds",
    quantity: runtimeSeconds,
    unit: "seconds",
    sourceType: "runner_completion",
    sourceId: verified.record.runnerId,
    occurredAt: new Date().toISOString(),
  });
  await deps.usageStore.recordUsageEventIfNew({
    organizationId: verified.record.organizationId,
    eventType: "runner_job",
    quantity: 1,
    unit: "jobs",
    sourceType: "runner_completion",
    sourceId: verified.record.runnerId,
    occurredAt: new Date().toISOString(),
  });

  await deps.recordAuditEvent({
    organizationId: verified.record.organizationId,
    action: "runner.execution_completed",
    targetType: "runner",
    targetId: verified.record.runnerId,
    metadata: { jobId: verified.record.jobId, exitCode: input.exitCode, runtimeSeconds, costEstimateUsd: cost.estimatedUsd, stdoutTruncated: stdout.length < input.stdout.length, stdoutPreview: stdout.slice(0, 200), stderrPreview: stderr.slice(0, 200) },
  });

  return { ok: true, data: { runnerId: verified.record.runnerId, jobId: verified.record.jobId, runtimeSeconds, costEstimateUsd: cost.estimatedUsd } };
}
