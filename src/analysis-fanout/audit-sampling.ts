/**
 * Periodic full-suite audit sampling (2026-08-25, "production-safe selective execution loop" follow-up to
 * Report 17). In real production selective execution, no full-suite comparison exists for most runs -
 * that's the entire economic point, and it's exactly what makes `rawFullSuiteOutcomePreserved` NOT_MEASURED
 * (baseline-fingerprint-gate.ts) the ordinary steady-state fact rather than an edge case. This module
 * decides, for a small deterministic fraction of merges, whether THIS one should ALSO run the full suite
 * anyway, purely to keep collecting real evidence of whether selective execution's outcome matches the
 * full suite's - continuously turning NOT_MEASURED into PRESERVED/NOT_PRESERVED for a sampled subset (fed
 * into safety-budget.ts's running track record) rather than never measuring it again once a repository
 * moves off this mission's own always-run-both validation harness.
 *
 * Deterministic, not Math.random() - the SAME mergeSha always gets the SAME sampling decision under the
 * SAME policy, so a result is reproducible and auditable rather than depending on wall-clock timing of the
 * request. Pure - no I/O, no clock.
 */

export interface AuditSamplingPolicy {
  /** Fraction of eligible merges that should ALSO run a full-suite audit, in [0, 1]. E.g. 0.1 = roughly
   * 1 in 10 over a large number of merges - not a promise of exact frequency over a small sample, since
   * this is a per-merge deterministic hash decision, not literal random sampling without replacement. */
  auditFraction: number;
}

export const DEFAULT_AUDIT_SAMPLING_POLICY: AuditSamplingPolicy = { auditFraction: 0.1 };

/** Deterministically maps a string to a pseudo-uniform value in [0, 1) via a simple string hash (FNV-1a) -
 * good enough for a sampling decision (not cryptographic, never claimed to be); the same input always
 * produces the same output, and different seeds are not correlated with each other in any way that would
 * bias WHICH merges get audited. */
function hashFraction(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0x100000000; // unsigned 32-bit, normalized to [0, 1)
}

export interface AuditSamplingResult {
  sampled: boolean;
  /** The [0,1) value this decision was computed from - present so a caller/report can verify the decision
   * without recomputing the hash, and so "why was THIS merge audited" is answerable from the record alone. */
  hashValue: number;
  policyFraction: number;
}

/** `seed` should be something stable and unique per merge (e.g. mergeSha) - reusing the SAME seed across
 * different merges would make their sampling decisions identical, defeating the point of sampling a
 * representative subset across many different merges. */
export function decideAuditSampling(seed: string, policy: AuditSamplingPolicy = DEFAULT_AUDIT_SAMPLING_POLICY): AuditSamplingResult {
  const hashValue = hashFraction(seed);
  return { sampled: hashValue < policy.auditFraction, hashValue, policyFraction: policy.auditFraction };
}
