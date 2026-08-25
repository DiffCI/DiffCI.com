/**
 * Differential-baseline safety gate (2026-08-25, DeepSeek execution-validation mission).
 *
 * Motivated by a real, measured gap: deepseek-harness's full test suite is not clean in this mission's
 * Cloudflare sandbox environment (16-18 pre-existing failures under root, 8 under a non-root CI-parity
 * experiment - see docs/research/2026-08-25-deepseek-execution-validation/07-14). `decideActivation`
 * (activation-gate.ts) already answers "is this selection correct, and is it economically worth running
 * fewer tests" - it says nothing about a THIRD, independent question this mission's evidence shows
 * matters: is it safe to treat a selected suite's pass/fail result as representative of the full suite's
 * health, when the full suite itself is not clean?
 *
 * A selected suite reporting "0 failures" is not the same claim as "this commit is healthy" if the full
 * suite has pre-existing failures the selected suite never had a chance to observe. This module's answer:
 * selective execution may only be trusted as a full-suite proxy when a TRUSTED FINGERPRINT of the base
 * commit's own known failures exists, is for the exact base SHA in question, and is recent enough to
 * still be believed. No fingerprint (or a stale/mismatched one) means REFUSE, never a silent default to
 * "assume clean" or "assume the same as last time."
 *
 * Deliberately pure and repository-independent, matching activation-gate.ts's own discipline: no network,
 * no sandbox, no clock access (a `now` is threaded in, never read internally) - a caller supplies real
 * fingerprint data (e.g. from a real base-SHA full-suite run, exactly as this mission performed for
 * PR #2760 and PR #2808) and gets a decision back, nothing more.
 *
 * This module does NOT build a repository-specific quarantine list - explicitly out of scope per the
 * mission's own instruction. It only decides whether a supplied fingerprint may be trusted, and classifies
 * observed failures against it; a caller who never supplies a fingerprint always gets REFUSE_NO_FINGERPRINT.
 */

export type BaselineSafetyDecision =
  | "ACTIVATE"
  | "REFUSE_NO_FINGERPRINT"
  | "REFUSE_WRONG_BASE"
  | "REFUSE_STALE_FINGERPRINT";

/** A trusted record of a repository's own known-failing tests at one specific base commit, established by
 * a real full-suite run - never fabricated, never inferred from a different commit. */
export interface BaselineFingerprint {
  repository: string;
  baseSha: string;
  /** Exact failedTests identity strings (same "file :: fullName" shape used throughout this mission's
   * ExecutionRecords) from a real full-suite run at exactly this baseSha. */
  knownFailures: readonly string[];
  /** When the fingerprint was established (caller-supplied epoch ms - this module never reads a clock). */
  establishedAtMs: number;
}

export interface BaselineSafetyInput {
  repository: string;
  /** The merge's own base SHA - what the fingerprint must match exactly. A fingerprint from a DIFFERENT
   * base (even a recent one, even a parent-of-parent) is never silently accepted as close enough. */
  currentBaseSha: string;
  /** Undefined when no fingerprint has ever been established for this repository/base - the expected,
   * ordinary state for a repository this policy has not yet been run against, not an error. */
  fingerprint: BaselineFingerprint | undefined;
  /** How old a fingerprint may be before it is no longer trusted (the target repository could have
   * drifted - new flaky tests, fixed tests, environment changes). Required, not defaulted, so a caller
   * can never silently accept an arbitrarily old fingerprint by omission. */
  maxFingerprintAgeMs: number;
  /** Caller-supplied "now" - this module has no clock of its own. */
  nowMs: number;
}

export interface BaselineSafetyResult {
  decision: BaselineSafetyDecision;
  explanation: string;
  fingerprintAgeMs?: number;
}

/**
 * Decide whether a selected suite's result may be trusted as a proxy for full-suite health for this
 * merge. Policy, in priority order:
 *   1. No fingerprint at all -> REFUSE_NO_FINGERPRINT (the ordinary, expected state until one is built).
 *   2. Fingerprint exists but is for a different base SHA -> REFUSE_WRONG_BASE (never reused across a
 *      rebase/different-branch/history-diverged scenario just because it's the "most recent" one on hand).
 *   3. Fingerprint is for the right base but older than maxFingerprintAgeMs -> REFUSE_STALE_FINGERPRINT.
 *   4. Otherwise -> ACTIVATE (the fingerprint may be used to classify observed failures - see
 *      classifyAgainstFingerprint below).
 */
export function decideBaselineSafety(input: BaselineSafetyInput): BaselineSafetyResult {
  const { currentBaseSha, fingerprint, maxFingerprintAgeMs, nowMs } = input;

  if (!fingerprint) {
    return {
      decision: "REFUSE_NO_FINGERPRINT",
      explanation: "no trusted base-SHA failure fingerprint exists for this repository - a selected " +
        "suite's result cannot be treated as representative of full-suite health without one",
    };
  }

  if (fingerprint.baseSha !== currentBaseSha) {
    return {
      decision: "REFUSE_WRONG_BASE",
      explanation: `fingerprint is for base ${fingerprint.baseSha.slice(0, 12)}, this merge's base is ` +
        `${currentBaseSha.slice(0, 12)} - a fingerprint is never reused across a different base commit, ` +
        "however recent",
    };
  }

  const fingerprintAgeMs = nowMs - fingerprint.establishedAtMs;
  if (fingerprintAgeMs > maxFingerprintAgeMs) {
    return {
      decision: "REFUSE_STALE_FINGERPRINT",
      explanation: `fingerprint is ${(fingerprintAgeMs / 3_600_000).toFixed(1)}h old, exceeding the ` +
        `${(maxFingerprintAgeMs / 3_600_000).toFixed(1)}h trust window - the repository may have drifted`,
      fingerprintAgeMs,
    };
  }

  return {
    decision: "ACTIVATE",
    explanation: `trusted fingerprint for base ${currentBaseSha.slice(0, 12)}, established ` +
      `${(fingerprintAgeMs / 60_000).toFixed(1)}min ago - observed failures may be classified against it`,
    fingerprintAgeMs,
  };
}

export interface FailureClassification {
  /** Observed failures that exactly match a known-pre-existing entry in the fingerprint - not a new
   * signal from this merge, safe to treat as already-accounted-for. */
  knownFailures: readonly string[];
  /** Observed failures NOT present in the fingerprint - a genuine, actionable new signal. */
  newFailures: readonly string[];
  /** True only when newFailures is empty. A merge with knownFailures.length > 0 can still be "clean" in
   * this sense - pre-existing failures are not this merge's fault, only a NEW failure blocks it. */
  clean: boolean;
}

/**
 * Classify a suite's observed failures against a trusted fingerprint. Exact string match only (same
 * discipline as this mission's own manual failedTests diffing throughout Reports 11-14) - no fuzzy or
 * normalized matching, since a near-miss could just as easily be a genuinely different, actionable
 * failure as a renamed/reworded instance of a known one.
 *
 * Callers MUST check `decideBaselineSafety` first - this function does not itself refuse to run against
 * an untrusted (missing/wrong-base/stale) fingerprint; it is a pure classification step, not the gate
 * itself. An undefined fingerprint here degrades to "every observed failure is new" (the same as an empty
 * known-failures list), which is exactly the conservative behavior the gate's REFUSE_* outcomes are meant
 * to be paired with, not a substitute for calling it.
 */
export function classifyAgainstFingerprint(
  observedFailures: readonly string[],
  fingerprint: BaselineFingerprint | undefined,
): FailureClassification {
  const known = new Set(fingerprint?.knownFailures ?? []);
  const knownFailures = observedFailures.filter((t) => known.has(t));
  const newFailures = observedFailures.filter((t) => !known.has(t));
  return { knownFailures, newFailures, clean: newFailures.length === 0 };
}
