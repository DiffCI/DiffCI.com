/**
 * Paces GitHub REST API calls made while collecting historical CI evidence for the Stage 0 research
 * corpus. Without a token, unauthenticated GitHub REST calls are capped at 60/hour account-wide; this
 * tracks a conservative sub-budget (default 50/hour, leaving headroom for any other concurrent use of
 * the same IP) so historical-evidence collection degrades gracefully to UNAVAILABLE rather than
 * silently erroring out or, worse, getting the whole pipeline rate-limited.
 *
 * See diffci/docs/research/2026-08-20-stage0-full-experiment-architecture.md §4.
 */

const HOUR_MS = 60 * 60 * 1000;

export interface RateBudget {
  readonly maxCallsPerHour: number;
  windowStartMs: number;
  callsUsedThisWindow: number;
}

export const DEFAULT_UNAUTHENTICATED_CALLS_PER_HOUR = 50;
export const DEFAULT_AUTHENTICATED_CALLS_PER_HOUR = 4500;

export function createRateBudget(maxCallsPerHour: number = DEFAULT_UNAUTHENTICATED_CALLS_PER_HOUR, nowMs: number = Date.now()): RateBudget {
  return { maxCallsPerHour, windowStartMs: nowMs, callsUsedThisWindow: 0 };
}

function rolloverIfNeeded(budget: RateBudget, nowMs: number): void {
  if (nowMs - budget.windowStartMs >= HOUR_MS) {
    budget.windowStartMs = nowMs;
    budget.callsUsedThisWindow = 0;
  }
}

/** Whether attempting `estimatedCalls` more REST calls would still fit inside this rolling hour. */
export function hasBudgetFor(budget: RateBudget, estimatedCalls: number, nowMs: number = Date.now()): boolean {
  rolloverIfNeeded(budget, nowMs);
  return budget.callsUsedThisWindow + estimatedCalls <= budget.maxCallsPerHour;
}

/** Records that `actualCalls` REST calls were just made against this budget. */
export function chargeBudget(budget: RateBudget, actualCalls: number, nowMs: number = Date.now()): void {
  rolloverIfNeeded(budget, nowMs);
  budget.callsUsedThisWindow += actualCalls;
}

export function remainingBudget(budget: RateBudget, nowMs: number = Date.now()): number {
  rolloverIfNeeded(budget, nowMs);
  return Math.max(0, budget.maxCallsPerHour - budget.callsUsedThisWindow);
}
