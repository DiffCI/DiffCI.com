/**
 * Preflight verdict shaping (Preflight P1 Part J). THE hard boundary of this whole system: Preflight
 * P1 may only ever produce one of exactly three advisory verdicts - PASS, WARN, HIGH_RISK. Nothing in
 * this module (or anywhere else under src/preflight/) sets a process exit code, writes a required
 * GitHub check/status, cancels a workflow run, or skips a test - there is no enforcement code path to
 * find, by construction. A verdict is information a human or a future, separately-authorized system
 * can act on; it is never itself an action.
 *
 * Do NOT add a "block"/"fail"/"cancel" branch here or anywhere in src/preflight/ without an explicit,
 * separate authorization from the user - Preflight P1's own spec is unambiguous: "Do NOT implement
 * enforcement. Do NOT block CI. Do NOT skip CI."
 */
export type PreflightVerdict = "PASS" | "WARN" | "HIGH_RISK";

export interface VerdictThresholds {
  /** failureRiskScore at or above this is at least WARN. */
  warnAtOrAbove: number;
  /** failureRiskScore at or above this is HIGH_RISK. Must be >= warnAtOrAbove. */
  highRiskAtOrAbove: number;
}

// Hand-set, matching risk-model.ts's own "small integers, easy to reason about by inspection"
// discipline (Part 9) - not fit to data. highRiskAtOrAbove=6 means a single confirmed
// runtime_parity_incompatible/MAJOR_MISMATCH/CONFLICTING signal (weight 6-7) or a known failure
// fingerprint match (weight 6) alone is enough to reach HIGH_RISK on its own, without needing to
// stack with anything else - each of those is real, standalone, high-confidence evidence.
export const DEFAULT_VERDICT_THRESHOLDS: VerdictThresholds = { warnAtOrAbove: 3, highRiskAtOrAbove: 6 };

export function computePreflightVerdict(failureRiskScore: number, thresholds: VerdictThresholds = DEFAULT_VERDICT_THRESHOLDS): PreflightVerdict {
  if (thresholds.highRiskAtOrAbove < thresholds.warnAtOrAbove) {
    throw new Error(`invalid VerdictThresholds: highRiskAtOrAbove (${thresholds.highRiskAtOrAbove}) must be >= warnAtOrAbove (${thresholds.warnAtOrAbove})`);
  }
  if (failureRiskScore >= thresholds.highRiskAtOrAbove) return "HIGH_RISK";
  if (failureRiskScore >= thresholds.warnAtOrAbove) return "WARN";
  return "PASS";
}

export interface PreflightSummary {
  verdict: PreflightVerdict;
  failureRiskScore: number;
  riskReasons: readonly { signal: string; weight: number; detail: string }[];
  recommendedCheckIds: readonly string[];
  /** Present on every summary, regardless of verdict, so no output can be mistaken for a directive. */
  advisoryNotice: string;
}

const ADVISORY_NOTICE = "This is an advisory Preflight signal only. It does not block, cancel, or skip CI, and no automated system acts on it without separate, explicit authorization.";

export function buildPreflightSummary(input: { failureRiskScore: number; riskReasons: readonly { signal: string; weight: number; detail: string }[]; recommendedCheckIds: readonly string[] }, thresholds?: VerdictThresholds): PreflightSummary {
  return {
    verdict: computePreflightVerdict(input.failureRiskScore, thresholds),
    failureRiskScore: input.failureRiskScore,
    riskReasons: input.riskReasons,
    recommendedCheckIds: input.recommendedCheckIds,
    advisoryNotice: ADVISORY_NOTICE,
  };
}
