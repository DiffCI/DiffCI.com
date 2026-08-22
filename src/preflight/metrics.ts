/**
 * Time-to-signal, avoided-downstream-work, and Preflight-overhead metrics (Preflight P1 Part F).
 * Follows the SAME "never fabricate precision" discipline as src/usage/savings.ts's counterfactual CI
 * savings model (measured/estimated/unknown, never a silently invented number) - deliberately its own,
 * self-contained implementation rather than importing from usage/savings.ts, so Preflight P1 stays as
 * structurally separate from the rest of the product as its storage already is (Part D's own rationale).
 */
import type { ReconciliationOutcome } from "./reconciliation.js";

export type MetricConfidence = "measured" | "estimated" | "unknown";

export interface ValueWithConfidence<T> {
  value: T | "unknown";
  confidence: MetricConfidence;
}

function unknown<T>(): ValueWithConfidence<T> {
  return { value: "unknown", confidence: "unknown" };
}

// --- Time-to-signal --------------------------------------------------------------------------------

export interface TimeToSignalInput {
  /** Durations (ms) of the recommended checks, in planned order, up to and including whichever check
   * would have caught the failure - i.e. the real elapsed time before Preflight would have surfaced a
   * signal. Pass real measured durations when available; falls back to the check registry's own
   * estimatedDurationMs otherwise (still reported as "estimated", never upgraded to "measured"). */
  preflightCheckDurationsMs: number[];
  wereDurationsMeasured: boolean;
  /** reconciliation.timeToFailureMs - undefined when CI's own evidence didn't capture it (Part E
   * already allows this field to be absent). */
  actualTimeToFailureMs?: number;
}

export interface TimeToSignalResult {
  preflightSignalTimeMs: ValueWithConfidence<number>;
  /** How much earlier Preflight would have signaled than real CI did. Only computable when
   * actualTimeToFailureMs is known - never estimated from workflow total duration, which would
   * conflate "time to the failing step" with "time to finish everything," a real, disclosed gap
   * rather than a fabricated number. */
  improvementMs: ValueWithConfidence<number>;
}

export function computeTimeToSignal(input: TimeToSignalInput): TimeToSignalResult {
  const preflightSignalTimeMs = input.preflightCheckDurationsMs.reduce((sum, d) => sum + d, 0);
  const signalConfidence: MetricConfidence = input.wereDurationsMeasured ? "measured" : "estimated";
  const signal: ValueWithConfidence<number> = { value: preflightSignalTimeMs, confidence: signalConfidence };

  if (typeof input.actualTimeToFailureMs !== "number") {
    return { preflightSignalTimeMs: signal, improvementMs: unknown() };
  }
  const improvementMs = input.actualTimeToFailureMs - preflightSignalTimeMs;
  // The improvement can never be more certain than the signal time it's derived from.
  return { preflightSignalTimeMs: signal, improvementMs: { value: improvementMs, confidence: signalConfidence } };
}

// --- Avoided downstream work -----------------------------------------------------------------------

export interface AvoidedWorkInput {
  outcome: ReconciliationOutcome;
  totalWorkflowDurationMs: number;
}

/**
 * Only a TP (a confirmed, correctly-predicted, preventable failure) has any avoided-work claim at
 * all - Preflight P1 never blocks or skips CI (explicit non-goal, Part J), so the "avoided" run is
 * always counterfactual: it assumes a developer acted on the warning and didn't push the change,
 * which this system never observes directly. That counterfactual nature is exactly why this can never
 * be "measured" - "estimated" is the honest ceiling, matching Part F's "measured vs. estimated vs.
 * unknown, never fabricated" requirement. TN/FP/FN/NOT_EVALUABLE all return "unknown" - there is no
 * avoided-work claim to make for any of them (a miss avoided nothing; a false alarm avoided nothing
 * real; a quiet correct pass never had anything to avoid).
 */
export function estimateAvoidedDownstreamWork(input: AvoidedWorkInput): ValueWithConfidence<number> {
  if (input.outcome !== "TP") return unknown();
  return { value: input.totalWorkflowDurationMs, confidence: "estimated" };
}

// --- Preflight overhead on successful commits --------------------------------------------------------

export interface PreflightOverheadInput {
  /** Real measured durations, when the recommended checks actually ran (live). */
  measuredCheckDurationsMs?: number[];
  /** Registry-estimated durations - always available as a fallback, never itself claimed as measured. */
  estimatedCheckDurationsMs: number[];
}

export function computePreflightOverhead(input: PreflightOverheadInput): ValueWithConfidence<number> {
  if (input.measuredCheckDurationsMs && input.measuredCheckDurationsMs.length > 0) {
    return { value: input.measuredCheckDurationsMs.reduce((sum, d) => sum + d, 0), confidence: "measured" };
  }
  if (input.estimatedCheckDurationsMs.length === 0) {
    // No checks were planned at all - genuinely zero overhead, nothing to estimate.
    return { value: 0, confidence: "measured" };
  }
  return { value: input.estimatedCheckDurationsMs.reduce((sum, d) => sum + d, 0), confidence: "estimated" };
}
