/**
 * Preventability classification (Part 4) - deliberately conservative, matching the discipline already
 * established for DiffCI's own safety classifications (src/shadow/failure-classification.ts's own doc
 * comment: "do not invent classifications when evidence is insufficient"). Not every failure is forced
 * into a "preventable" bucket (Part 4's explicit instruction) - UNKNOWN and NOT_REASONABLY_PREVENTABLE
 * are first-class, legitimate outcomes.
 */
import type { FailureClass } from "./taxonomy.js";

export type PreventabilityClass = "DETERMINISTIC_PREFLIGHT" | "TARGETED_TEST_PREFLIGHT" | "KNOWN_FAILURE_PREFLIGHT" | "POTENTIALLY_PREDICTABLE" | "NOT_REASONABLY_PREVENTABLE" | "UNKNOWN";

export interface PreventabilityInput {
  failureClass: FailureClass;
  /** Whether an earlier CI run (a different commit) produced the SAME errorFingerprint at least once
   * before this occurrence - the concrete evidence behind KNOWN_FAILURE_PREFLIGHT. */
  fingerprintSeenBefore: boolean;
  /** Whether the diff that caused this failure touched a file directly implicated in the failing
   * test/module (i.e. a plain SELECTIVE-style impact match would very plausibly have run it). */
  changedFilesDirectlyImplicated?: boolean;
  /** e.g. a transient infra symptom, a provider outage, or a retry-without-change that succeeded. */
  evidenceOfTransientCause?: boolean;
  /** Set when there simply isn't enough captured evidence (log unavailable, ambiguous class) to say
   * anything - forces UNKNOWN rather than a guess. */
  insufficientEvidence?: boolean;
}

const DETERMINISTIC_CLASSES: ReadonlySet<FailureClass> = new Set(["TYPECHECK", "LINT", "BUILD", "DEPENDENCY", "CONFIGURATION", "GENERATED_ARTIFACT"]);
const NOT_PREVENTABLE_CLASSES: ReadonlySet<FailureClass> = new Set(["RUNNER_INFRASTRUCTURE"]);

export function classifyPreventability(input: PreventabilityInput): { preventability: PreventabilityClass; reason: string } {
  if (input.insufficientEvidence) {
    return { preventability: "UNKNOWN", reason: "insufficient captured evidence to classify" };
  }

  if (input.evidenceOfTransientCause || (NOT_PREVENTABLE_CLASSES.has(input.failureClass) && !input.fingerprintSeenBefore)) {
    return { preventability: "NOT_REASONABLY_PREVENTABLE", reason: `failure class ${input.failureClass} with evidence of a transient/infrastructure cause, not a defect a preflight check could reasonably have caught` };
  }

  // A cheap deterministic check (typecheck/lint/build/dependency/config validation) is available and
  // would, by construction, have caught this class of failure - the strongest, least-inferential bucket.
  if (DETERMINISTIC_CLASSES.has(input.failureClass)) {
    return { preventability: "DETERMINISTIC_PREFLIGHT", reason: `failure class ${input.failureClass} is directly caught by a cheap deterministic check (typecheck/lint/build/dependency/config validation)` };
  }

  // A recurring fingerprint is the strongest KNOWN_FAILURE_PREFLIGHT evidence - checked before
  // TARGETED_TEST_PREFLIGHT because "this exact failure happened before" is a stronger, more specific
  // claim than "the diff touched implicated files."
  if (input.fingerprintSeenBefore) {
    return { preventability: "KNOWN_FAILURE_PREFLIGHT", reason: "an identical error fingerprint was observed in an earlier CI run - a known-pattern check could have flagged this before CI ran" };
  }

  if ((input.failureClass === "UNIT_TEST" || input.failureClass === "INTEGRATION_TEST") && input.changedFilesDirectlyImplicated) {
    return { preventability: "TARGETED_TEST_PREFLIGHT", reason: "the failing test is directly implicated by the changed files - a targeted/impacted test run would very likely have exposed this before full CI" };
  }

  if (input.failureClass === "UNIT_TEST" || input.failureClass === "INTEGRATION_TEST" || input.failureClass === "SECURITY_SCAN") {
    return { preventability: "POTENTIALLY_PREDICTABLE", reason: `failure class ${input.failureClass} without a direct changed-file/test match or known fingerprint - useful signals may exist but no deterministic prevention rule is established yet` };
  }

  return { preventability: "UNKNOWN", reason: `failure class ${input.failureClass} did not match any established preventability rule` };
}
