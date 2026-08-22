/**
 * Historical failure "memory" (Preflight P1 Part H) - backs src/preflight/cloudflare/schema.sql's
 * preflight_known_failures table and preventability.ts's existing fingerprintSeenBefore signal.
 * Deliberately treats a match as a STRONG signal, never certainty - Part H's own instruction ("without
 * treating similarity as certainty") and the same discipline preventability.ts already documents for
 * KNOWN_FAILURE_PREFLIGHT ("an identical fingerprint... a known-pattern check COULD have flagged this",
 * not "would definitely have").
 */
import type { FailureClass } from "./taxonomy.js";

export interface KnownFailureRecord {
  errorFingerprint: string;
  failureClass: FailureClass;
  affectedFiles: string[];
  /** The check id (from checks-registry.ts) known to detect this fingerprint's failure class, if a
   * past reconciliation established one via isEligibleForPrevention() - undefined if no such check has
   * ever been confirmed for it. */
  exposingCheckId?: string;
  recurrenceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface FailureOccurrence {
  errorFingerprint: string;
  failureClass: FailureClass;
  changedFiles: string[];
  occurredAt: string;
  exposingCheckId?: string;
}

/** Pure upsert - callers own persistence (D1 UPSERT in production, a Map in tests). Never silently
 * drops the running affected-files history; a fingerprint recurring across different modules is
 * itself useful evidence, not noise to discard. */
export function upsertKnownFailure(existing: KnownFailureRecord | undefined, occurrence: FailureOccurrence): KnownFailureRecord {
  if (!existing) {
    return {
      errorFingerprint: occurrence.errorFingerprint,
      failureClass: occurrence.failureClass,
      affectedFiles: [...new Set(occurrence.changedFiles)],
      exposingCheckId: occurrence.exposingCheckId,
      recurrenceCount: 1,
      firstSeenAt: occurrence.occurredAt,
      lastSeenAt: occurrence.occurredAt,
    };
  }
  return {
    ...existing,
    affectedFiles: [...new Set([...existing.affectedFiles, ...occurrence.changedFiles])],
    // Keep the first-ever confirmed exposing check rather than overwrite it with a later, possibly
    // less-specific one - the earliest confirmation is real evidence; a later occurrence's absence of
    // one is not evidence the earlier confirmation was wrong.
    exposingCheckId: existing.exposingCheckId ?? occurrence.exposingCheckId,
    recurrenceCount: existing.recurrenceCount + 1,
    lastSeenAt: occurrence.occurredAt,
  };
}

export function matchKnownFailure(knownFailures: readonly KnownFailureRecord[], errorFingerprint: string): KnownFailureRecord | undefined {
  return knownFailures.find((k) => k.errorFingerprint === errorFingerprint);
}

export interface KnownPatternRecommendation {
  matched: boolean;
  record?: KnownFailureRecord;
  /** Always human-readable and always explicit about the strength of the evidence - never a bare
   * boolean presented as a verdict. */
  recommendation: string;
}

export function recommendFromKnownFailures(knownFailures: readonly KnownFailureRecord[], errorFingerprint: string): KnownPatternRecommendation {
  const record = matchKnownFailure(knownFailures, errorFingerprint);
  if (!record) {
    return { matched: false, recommendation: "no known-fingerprint match in recorded history - this is an absence of evidence, not evidence the change is safe" };
  }
  const checkNote = record.exposingCheckId ? `; ${record.exposingCheckId} is confirmed to detect it` : "; no specific check has yet been confirmed to detect it";
  return {
    matched: true,
    record,
    recommendation: `this error fingerprint recurred ${record.recurrenceCount} time(s) before (first: ${record.firstSeenAt}, last: ${record.lastSeenAt}) as a ${record.failureClass} failure${checkNote} - a strong but NOT certain signal; treat as elevated risk, not proof of recurrence`,
  };
}
