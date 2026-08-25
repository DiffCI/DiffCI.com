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
  | "REFUSE_IDENTITY_MISMATCH"
  | "REFUSE_STALE_FINGERPRINT";

/** A trusted record of a repository's own known-failing tests at one specific base commit, established by
 * a real full-suite run - never fabricated, never inferred from a different commit.
 *
 * Identity fields (2026-08-25, hard-wired enforcement round): `repository`+`baseSha` alone are not enough
 * to trust a fingerprint - the SAME base commit tested under a different branch, execution environment
 * (e.g. root vs the CI-parity non-root mode - Report 13/14 measured materially different failure counts
 * for the exact same commit), test family, or command shape can legitimately have a DIFFERENT true
 * failure set. All six fields must match exactly, not just the two most obvious ones. In practice the
 * fingerprint STORE key already encodes branch/environmentIdentity/testFamily/commandIdentity (so a
 * mismatch on those usually surfaces as REFUSE_NO_FINGERPRINT - no object at that key), but every field is
 * still re-verified against the fetched object's own content as defense-in-depth against a key-scheme bug
 * or a caller constructing the key incorrectly. */
export interface BaselineFingerprint {
  repository: string;
  branch: string;
  baseSha: string;
  /** e.g. "root" / "nonroot" - see execution-shard-do.ts's runAsNonRoot. Any real distinguishing
   * environment property; this module does not interpret the string, only compares it for equality. */
  environmentIdentity: string;
  /** e.g. "unit" - the modeled test family this fingerprint's failures were observed in. */
  testFamily: string;
  /** The exact test-invocation argv (joined), e.g. "test --no-isolate" - a full-suite run under a
   * DIFFERENT command shape is not the same measurement, even same repo/base/branch/environment. */
  commandIdentity: string;
  /** Exact failedTests identity strings (same "file :: fullName" shape used throughout this mission's
   * ExecutionRecords) from a real full-suite run at exactly this baseSha. */
  knownFailures: readonly string[];
  /** When the fingerprint was established (caller-supplied epoch ms - this module never reads a clock). */
  establishedAtMs: number;
}

export interface BaselineSafetyInput {
  repository: string;
  branch: string;
  /** The merge's own base SHA - what the fingerprint must match exactly. A fingerprint from a DIFFERENT
   * base (even a recent one, even a parent-of-parent) is never silently accepted as close enough. */
  currentBaseSha: string;
  environmentIdentity: string;
  testFamily: string;
  commandIdentity: string;
  /** Undefined when no fingerprint has ever been established for this repository/base/environment/family/
   * command combination - the expected, ordinary state for one this policy has not yet been run against,
   * not an error. */
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
 *   1. No fingerprint at all -> REFUSE_NO_FINGERPRINT (the ordinary, expected state until one is built,
 *      or the ordinary CONSEQUENCE of a different branch/environment/testFamily/command never having one).
 *   2. Fingerprint exists but is for a different base SHA -> REFUSE_WRONG_BASE (never reused across a
 *      rebase/different-branch/history-diverged scenario just because it's the "most recent" one on hand).
 *   3. Fingerprint's base matches but another identity field (branch/environment/testFamily/command)
 *      does not -> REFUSE_IDENTITY_MISMATCH (defense-in-depth - the fingerprint STORE key should already
 *      prevent fetching a fingerprint for the wrong identity, this catches a key-scheme bug instead of
 *      trusting mismatched content).
 *   4. Fingerprint is for the right identity but older than maxFingerprintAgeMs -> REFUSE_STALE_FINGERPRINT.
 *   5. Otherwise -> ACTIVATE (the fingerprint may be used to classify observed failures - see
 *      classifyAgainstFingerprint below).
 */
export function decideBaselineSafety(input: BaselineSafetyInput): BaselineSafetyResult {
  const { repository, branch, currentBaseSha, environmentIdentity, testFamily, commandIdentity, fingerprint, maxFingerprintAgeMs, nowMs } = input;

  if (!fingerprint) {
    return {
      decision: "REFUSE_NO_FINGERPRINT",
      explanation: "no trusted base-SHA failure fingerprint exists for this exact repository/branch/base/" +
        "environment/testFamily/command combination - a selected suite's result cannot be treated as " +
        "representative of full-suite health without one",
    };
  }

  if (fingerprint.repository !== repository || fingerprint.baseSha !== currentBaseSha) {
    return {
      decision: "REFUSE_WRONG_BASE",
      explanation: `fingerprint is for ${fingerprint.repository}@${fingerprint.baseSha.slice(0, 12)}, this ` +
        `merge is ${repository}@${currentBaseSha.slice(0, 12)} - a fingerprint is never reused across a ` +
        "different base commit, however recent",
    };
  }

  if (fingerprint.branch !== branch || fingerprint.environmentIdentity !== environmentIdentity || fingerprint.testFamily !== testFamily || fingerprint.commandIdentity !== commandIdentity) {
    const mismatches: string[] = [];
    if (fingerprint.branch !== branch) mismatches.push(`branch (${fingerprint.branch} != ${branch})`);
    if (fingerprint.environmentIdentity !== environmentIdentity) mismatches.push(`environmentIdentity (${fingerprint.environmentIdentity} != ${environmentIdentity})`);
    if (fingerprint.testFamily !== testFamily) mismatches.push(`testFamily (${fingerprint.testFamily} != ${testFamily})`);
    if (fingerprint.commandIdentity !== commandIdentity) mismatches.push(`commandIdentity (${fingerprint.commandIdentity} != ${commandIdentity})`);
    return {
      decision: "REFUSE_IDENTITY_MISMATCH",
      explanation: `fingerprint matches repository/base but not: ${mismatches.join(", ")} - a fingerprint ` +
        "from a different environment or command shape is never trusted, even for the identical commit",
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

/**
 * The composed, hard-wired activation rule (2026-08-25) - the single function meant to gate real
 * execution, combining all three independent gates (selection correctness, economics, and this module's
 * own baseline safety) plus a fourth check this mission's evidence showed matters just as much: did the
 * SELECTED suite actually preserve every NEW (non-fingerprinted) failure the FULL suite observed. A
 * selection can be correct, economically beneficial, and run against a safe/fingerprinted baseline, and
 * still be unsafe to trust if it happens to miss a real new regression - exactly the scope gap #2844
 * exposed (Report 07/11), generalized into an explicit, checked condition rather than a one-off finding.
 *
 *   EXECUTE_SELECTIVELY only if
 *     selection verdict is safe
 *     AND economics gate passes
 *     AND (full-suite observation shows zero failures OR a trusted exact-identity fingerprint activates)
 *     AND selected execution's new-failure set is a superset of the full suite's new-failure set
 *
 * `fullObservedFailures` is undefined when the caller genuinely never ran a full suite this time (the
 * ordinary REAL-production shape, where selective execution exists specifically to avoid that cost) - in
 * that case only the fingerprint path can authorize ACTIVATE; there is nothing to compare the selected
 * suite's own failures against directly, so the "preserves every new failure" check is trivially satisfied
 * by definition (there is no independently-observed full-suite new-failure set to have missed) and the
 * fingerprint's own trust becomes the ENTIRE safety argument - which is exactly why `decideBaselineSafety`
 * refuses so conservatively when a fingerprint is missing, stale, or identity-mismatched.
 */
export type FinalActivationDecision =
  | "EXECUTE_SELECTIVELY"
  | "REFUSE_SELECTION_UNSAFE"
  | "REFUSE_ECONOMICS_NOT_BENEFICIAL"
  | "REFUSE_BASELINE_UNSAFE"
  | "REFUSE_NEW_FAILURE_NOT_PRESERVED";

export interface FinalActivationInput {
  selectionSafe: boolean;
  economicsBeneficial: boolean;
  /** Any baseline-safety verdict shape with a `decision`/`explanation` (2026-08-25: widened from the
   * single-sample-only `BaselineSafetyResult` so the rolling, multi-sample gate's own
   * `RollingBaselineSafetyResult` - a materially different decision union - composes here unchanged; this
   * function only ever compares `.decision !== "ACTIVATE"` as a plain string, never assumes which gate
   * produced it). */
  baselineSafety: { decision: string; explanation: string };
  fingerprint: BaselineFingerprint | undefined;
  /** The full suite's own observed failures THIS run, if one was actually executed (validation/measurement
   * contexts like this mission always have one; true steady-state production selective execution will not). */
  fullObservedFailures: readonly string[] | undefined;
  /** The selected suite's own observed failures - always present, selective execution's whole point. */
  selectedObservedFailures: readonly string[];
}

export interface FinalActivationResult {
  decision: FinalActivationDecision;
  explanation: string;
  newFailuresInFull: readonly string[];
  newFailuresInSelected: readonly string[];
  /** Full-suite new failures the selected suite's own new-failure set does NOT contain - non-empty is
   * exactly the condition that forces REFUSE_NEW_FAILURE_NOT_PRESERVED. */
  newFailuresMissedBySelection: readonly string[];
}

export function decideFinalActivation(input: FinalActivationInput): FinalActivationResult {
  const { selectionSafe, economicsBeneficial, baselineSafety, fingerprint, fullObservedFailures, selectedObservedFailures } = input;

  const selectedClassification = classifyAgainstFingerprint(selectedObservedFailures, fingerprint);
  const fullClassification = fullObservedFailures !== undefined ? classifyAgainstFingerprint(fullObservedFailures, fingerprint) : undefined;
  const newFailuresInFull = fullClassification?.newFailures ?? [];
  const newFailuresInSelected = selectedClassification.newFailures;
  const selectedNewSet = new Set(newFailuresInSelected);
  const newFailuresMissedBySelection = newFailuresInFull.filter((t) => !selectedNewSet.has(t));

  const base = { newFailuresInFull, newFailuresInSelected, newFailuresMissedBySelection };

  if (!selectionSafe) {
    return { decision: "REFUSE_SELECTION_UNSAFE", explanation: "selection verdict is not safe - economics and baseline are moot", ...base };
  }
  if (!economicsBeneficial) {
    return { decision: "REFUSE_ECONOMICS_NOT_BENEFICIAL", explanation: "economics gate does not authorize activation for this merge", ...base };
  }
  // "baseline is clean" as an independent path to safety, alongside a trusted fingerprint: a full suite
  // that was actually run THIS time and observed zero failures needs no fingerprint at all to trust.
  const baselineCleanThisRun = fullObservedFailures !== undefined && fullObservedFailures.length === 0;
  if (baselineSafety.decision !== "ACTIVATE" && !baselineCleanThisRun) {
    return { decision: "REFUSE_BASELINE_UNSAFE", explanation: `baseline safety gate: ${baselineSafety.explanation}`, ...base };
  }
  if (newFailuresMissedBySelection.length > 0) {
    return {
      decision: "REFUSE_NEW_FAILURE_NOT_PRESERVED",
      explanation: `the full suite observed ${newFailuresMissedBySelection.length} new failure(s) beyond the ` +
        `trusted fingerprint that the selected suite's own results do not contain - selective execution is ` +
        "never trusted to have caught something it demonstrably did not",
      ...base,
    };
  }
  return { decision: "EXECUTE_SELECTIVELY", explanation: "selection safe, economically beneficial, baseline trusted (clean or fingerprinted), every observed new failure preserved by the selected suite", ...base };
}
