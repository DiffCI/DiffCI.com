/**
 * The runner state machine (Part 13). Pure, provider-independent - neither RunnerProvider
 * implementations nor the D1 store are allowed to write a status transition that this module would
 * reject; store.ts's transitionRunnerStatus() calls assertValidTransition() before ever issuing the
 * UPDATE.
 */
import type { RunnerState } from "./types.js";

export class InvalidRunnerTransitionError extends Error {
  constructor(
    public readonly from: RunnerState,
    public readonly to: RunnerState,
  ) {
    super(`Invalid runner state transition: ${from} -> ${to}`);
    this.name = "InvalidRunnerTransitionError";
  }
}

/**
 * requested -> provisioning -> ready -> assigned -> busy -> completed -> terminating -> terminated
 * with `failed` reachable from any pre-terminal state, and `terminating` reachable from any
 * non-terminal state (Part 15's timeout-driven forced cleanup can terminate a runner at any point in its
 * life, not only after it completes normally). `terminated -> terminated` is the one explicit self-loop
 * (Part 13: "terminate(terminated_runner) must be idempotent") - every other transition FROM terminated
 * is rejected, matching the spec's own example (`terminated -> busy` must be impossible).
 */
const ALLOWED_TRANSITIONS: Record<RunnerState, ReadonlySet<RunnerState>> = {
  requested: new Set(["provisioning", "failed", "terminating"]),
  provisioning: new Set(["ready", "failed", "terminating"]),
  ready: new Set(["assigned", "failed", "terminating"]),
  assigned: new Set(["busy", "failed", "terminating"]),
  busy: new Set(["completed", "failed", "terminating"]),
  completed: new Set(["terminating"]),
  failed: new Set(["terminating"]),
  terminating: new Set(["terminated", "failed"]), // teardown itself can fail (Part 15: termination retries)
  terminated: new Set(["terminated"]), // idempotent terminate only - nothing else is reachable
};

export function canTransition(from: RunnerState, to: RunnerState): boolean {
  return ALLOWED_TRANSITIONS[from].has(to);
}

export function assertValidTransition(from: RunnerState, to: RunnerState): void {
  if (!canTransition(from, to)) throw new InvalidRunnerTransitionError(from, to);
}
