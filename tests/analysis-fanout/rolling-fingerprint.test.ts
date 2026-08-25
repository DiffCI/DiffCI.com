import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyStability,
  decideRollingBaselineSafety,
  deriveEffectiveFingerprint,
  mergeObservation,
  DEFAULT_STABILITY_POLICY,
  ROLLING_FINGERPRINT_SCHEMA_VERSION,
  type RollingFingerprint,
} from "../../src/analysis-fanout/rolling-fingerprint.js";
import { classifyAgainstFingerprint, decideFinalActivation } from "../../src/analysis-fanout/baseline-fingerprint-gate.js";

const IDENTITY = { repository: "deepseek-ai/deepseek-harness", branch: "main", environmentIdentity: "nonroot", testFamily: "unit", commandIdentity: "test" };
const STABLE_TEST = { testId: "subprocess-local/tests/process-exit.spec.ts :: removes an ordinary managed tree", signature: "AssertionError: expected tree to be removed" };
const FLAKY_TEST = { testId: "subagent/tests/continuation.spec.ts :: some flaky assertion", signature: "TimeoutError: exceeded 5000ms" };
const MUTATION_FAILURE = { testId: "frontend-static/tests/frontend-static.spec.ts :: real Loader composition", signature: "AssertionError: expected 404 to be 200" };

describe("mergeObservation", () => {
  it("starts a fresh fingerprint from undefined and records one sample per observed (testId, signature)", () => {
    const r = mergeObservation(undefined, IDENTITY, [STABLE_TEST], "base1", 1000);
    assert.equal(r.totalBaseRunsSampled, 1);
    assert.deepEqual(r.baseShaHistory, ["base1"]);
    assert.equal(r.tracked.length, 1);
    assert.equal(r.tracked[0]!.observations.length, 1);
  });

  it("appends a new observation to an EXISTING (testId, signature) entry on a repeat base", () => {
    const r1 = mergeObservation(undefined, IDENTITY, [STABLE_TEST], "base1", 1000);
    const r2 = mergeObservation(r1, IDENTITY, [STABLE_TEST], "base2", 2000);
    assert.equal(r2.totalBaseRunsSampled, 2);
    assert.deepEqual(r2.baseShaHistory, ["base1", "base2"]);
    assert.equal(r2.tracked.length, 1);
    assert.equal(r2.tracked[0]!.observations.length, 2);
  });

  it("a DIFFERENT signature for the SAME testId starts its own separate tracked entry, not merged into the old one", () => {
    const r1 = mergeObservation(undefined, IDENTITY, [STABLE_TEST], "base1", 1000);
    const differentSignature = { testId: STABLE_TEST.testId, signature: "TypeError: something else entirely" };
    const r2 = mergeObservation(r1, IDENTITY, [differentSignature], "base2", 2000);
    assert.equal(r2.tracked.length, 2);
    assert.equal(r2.tracked.find((t) => t.signature === STABLE_TEST.signature)!.observations.length, 1);
    assert.equal(r2.tracked.find((t) => t.signature === differentSignature.signature)!.observations.length, 1);
  });

  it("a base run that observes NOTHING new still increments totalBaseRunsSampled - absence lowers frequency for everyone else", () => {
    const r1 = mergeObservation(undefined, IDENTITY, [STABLE_TEST], "base1", 1000);
    const r2 = mergeObservation(r1, IDENTITY, [], "base2", 2000);
    assert.equal(r2.totalBaseRunsSampled, 2);
    assert.equal(r2.tracked[0]!.observations.length, 1); // unchanged - STABLE_TEST wasn't observed this time
  });

  it("stamps every fresh series with the CURRENT ROLLING_FINGERPRINT_SCHEMA_VERSION", () => {
    const r = mergeObservation(undefined, IDENTITY, [STABLE_TEST], "base1", 1000);
    assert.equal(r.schemaVersion, ROLLING_FINGERPRINT_SCHEMA_VERSION);
  });

  // 2026-08-25: defense-in-depth for the PID-normalization fix (see ROLLING_FINGERPRINT_SCHEMA_VERSION's
  // own comment) - even if an incompatible series somehow reaches mergeObservation as `existing`, its
  // history must never be silently combined with fresh observations under different normalization rules.
  it("treats an `existing` fingerprint stamped with a DIFFERENT schemaVersion as absent - starts fresh rather than merging incompatible history", () => {
    const staleFromOldSchema: RollingFingerprint = {
      ...IDENTITY,
      schemaVersion: ROLLING_FINGERPRINT_SCHEMA_VERSION - 1,
      totalBaseRunsSampled: 5,
      baseShaHistory: ["old1", "old2", "old3", "old4", "old5"],
      tracked: [{ testId: STABLE_TEST.testId, signature: STABLE_TEST.signature, observations: [{ baseSha: "old1", observedAtMs: 100 }] }],
      updatedAtMs: 100,
    };
    const r = mergeObservation(staleFromOldSchema, IDENTITY, [STABLE_TEST], "new1", 2000);
    assert.equal(r.schemaVersion, ROLLING_FINGERPRINT_SCHEMA_VERSION);
    assert.equal(r.totalBaseRunsSampled, 1); // NOT 6 - the old series' count is discarded, not carried forward
    assert.deepEqual(r.baseShaHistory, ["new1"]); // NOT the 5 old bases plus this one
    assert.equal(r.tracked[0]!.observations.length, 1); // NOT 2 - the old sample is not merged in
  });
});

describe("classifyStability", () => {
  function rollingWith(observations: { baseSha: string; observedAtMs: number }[], baseShaHistory: string[], totalBaseRunsSampled = baseShaHistory.length) {
    return { totalBaseRunsSampled, baseShaHistory };
  }

  it("insufficient_samples below the policy minimum", () => {
    const entry = { testId: "x", signature: "y", observations: [{ baseSha: "b1", observedAtMs: 1000 }] };
    const r = classifyStability(entry, rollingWith([], ["b1", "b2", "b3"]), 1000);
    assert.equal(r, "insufficient_samples");
  });

  it("low_frequency when sample count is sufficient but the rate across all sampled bases is below the threshold", () => {
    // 3 observations out of 10 total bases sampled = 0.3, below the default 0.5 minFrequency
    const observations = [1, 2, 3].map((i) => ({ baseSha: `b${i}`, observedAtMs: 1000 * i }));
    const entry = { testId: "x", signature: "y", observations };
    const baseShaHistory = Array.from({ length: 10 }, (_, i) => `b${i + 1}`);
    const r = classifyStability(entry, rollingWith([], baseShaHistory, 10), 4000);
    assert.equal(r, "low_frequency");
  });

  it("stale when the LAST observation is older than the staleness window, even with plenty of total samples", () => {
    const observations = [1, 2, 3, 4, 5].map((i) => ({ baseSha: `b${i}`, observedAtMs: i * 1000 }));
    const entry = { testId: "x", signature: "y", observations };
    const baseShaHistory = Array.from({ length: 5 }, (_, i) => `b${i + 1}`);
    const nowMs = 5000 + DEFAULT_STABILITY_POLICY.maxStalenessMs + 1;
    const r = classifyStability(entry, rollingWith([], baseShaHistory, 5), nowMs);
    assert.equal(r, "stale");
  });

  it("frequency_increasing when the second half of sampled history shows a materially higher rate than the first half", () => {
    // 10 bases total: fails in bases 6-10 (recent half) but never in 1-5 (early half) -> recentFreq 1.0, earlyFreq 0
    const baseShaHistory = Array.from({ length: 10 }, (_, i) => `b${i + 1}`);
    const observations = [6, 7, 8, 9, 10].map((i) => ({ baseSha: `b${i}`, observedAtMs: i * 1000 }));
    const entry = { testId: "x", signature: "y", observations };
    const r = classifyStability(entry, rollingWith([], baseShaHistory, 10), 11000);
    assert.equal(r, "frequency_increasing");
  });

  it("stable when samples are sufficient, frequency is high, recent, and evenly distributed (not increasing)", () => {
    // fails in every one of 6 sampled bases - consistent throughout, not trending
    const baseShaHistory = Array.from({ length: 6 }, (_, i) => `b${i + 1}`);
    const observations = baseShaHistory.map((sha, i) => ({ baseSha: sha, observedAtMs: (i + 1) * 1000 }));
    const entry = { testId: "x", signature: "y", observations };
    const r = classifyStability(entry, rollingWith([], baseShaHistory, 6), 6500);
    assert.equal(r, "stable");
  });
});

describe("decideRollingBaselineSafety", () => {
  it("REFUSE_NO_ROLLING_FINGERPRINT is the ordinary starting state", () => {
    const r = decideRollingBaselineSafety({ ...IDENTITY, currentBaseSha: "base1", rolling: undefined, minTotalBaseRunsSampled: 3 });
    assert.equal(r.decision, "REFUSE_NO_ROLLING_FINGERPRINT");
  });

  it("REFUSE_SCHEMA_VERSION_MISMATCH when the stored fingerprint was built under a different normalizer version - checked BEFORE identity, never silently reused", () => {
    let rolling: RollingFingerprint | undefined = mergeObservation(undefined, IDENTITY, [], "base1", 1000);
    rolling = { ...rolling, schemaVersion: ROLLING_FINGERPRINT_SCHEMA_VERSION - 1 };
    const r = decideRollingBaselineSafety({ ...IDENTITY, currentBaseSha: "base1", rolling, minTotalBaseRunsSampled: 1 });
    assert.equal(r.decision, "REFUSE_SCHEMA_VERSION_MISMATCH");
  });

  it("REFUSE_IDENTITY_MISMATCH when the stored fingerprint is for a different environment", () => {
    const rolling = mergeObservation(undefined, { ...IDENTITY, environmentIdentity: "root" }, [], "base1", 1000);
    const r = decideRollingBaselineSafety({ ...IDENTITY, currentBaseSha: "base1", rolling, minTotalBaseRunsSampled: 1 });
    assert.equal(r.decision, "REFUSE_IDENTITY_MISMATCH");
  });

  it("REFUSE_BASE_NOT_SAMPLED when this exact base was never one of the samples, even if others were", () => {
    const rolling = mergeObservation(undefined, IDENTITY, [], "base1", 1000);
    const r = decideRollingBaselineSafety({ ...IDENTITY, currentBaseSha: "base2", rolling, minTotalBaseRunsSampled: 1 });
    assert.equal(r.decision, "REFUSE_BASE_NOT_SAMPLED");
  });

  it("REFUSE_INSUFFICIENT_TOTAL_SAMPLES when the fingerprint has fewer overall samples than required", () => {
    const rolling = mergeObservation(undefined, IDENTITY, [], "base1", 1000);
    const r = decideRollingBaselineSafety({ ...IDENTITY, currentBaseSha: "base1", rolling, minTotalBaseRunsSampled: 3 });
    assert.equal(r.decision, "REFUSE_INSUFFICIENT_TOTAL_SAMPLES");
  });

  it("ACTIVATE when identity matches, the base was sampled, and enough total samples exist", () => {
    let rolling: RollingFingerprint | undefined;
    for (let i = 1; i <= 3; i++) rolling = mergeObservation(rolling, IDENTITY, [], `base${i}`, i * 1000);
    const r = decideRollingBaselineSafety({ ...IDENTITY, currentBaseSha: "base2", rolling, minTotalBaseRunsSampled: 3 });
    assert.equal(r.decision, "ACTIVATE");
  });
});

// The three cases the user explicitly asked to be validated.
describe("the three requested validation cases (real composed pipeline: rolling -> deriveEffectiveFingerprint -> decideFinalActivation)", () => {
  it("case 1: a known, recurring baseline failure IS eligible for differential treatment (quarantined, activation proceeds)", () => {
    let rolling: RollingFingerprint | undefined;
    // 5 base samples, the stable failure present in all 5 - consistent signature, high frequency, recent.
    for (let i = 1; i <= 5; i++) rolling = mergeObservation(rolling, IDENTITY, [STABLE_TEST], `base${i}`, i * 1000);
    const nowMs = 6000;
    const effectiveFingerprint = deriveEffectiveFingerprint(rolling!, "base5", [STABLE_TEST], nowMs);
    assert.deepEqual(effectiveFingerprint.knownFailures, [STABLE_TEST.testId]);

    const safety = decideRollingBaselineSafety({ ...IDENTITY, currentBaseSha: "base5", rolling, minTotalBaseRunsSampled: 3 });
    assert.equal(safety.decision, "ACTIVATE");

    const activation = decideFinalActivation({
      selectionSafe: true,
      economicsBeneficial: true,
      baselineSafety: safety,
      fingerprint: effectiveFingerprint,
      fullObservedFailures: [STABLE_TEST.testId], // only the known, quarantine-eligible failure
      selectedObservedFailures: [],
    });
    assert.equal(activation.decision, "EXECUTE_SELECTIVELY");
    assert.deepEqual(activation.newFailuresInFull, []); // correctly NOT flagged as new
  });

  it("case 2: a previously-flaky test failing with a NEW signature is refused - the old signature's history does not cover it", () => {
    let rolling: RollingFingerprint | undefined;
    // FLAKY_TEST was seen with its ORIGINAL signature across 5 samples - would itself be stable/quarantinable.
    for (let i = 1; i <= 5; i++) rolling = mergeObservation(rolling, IDENTITY, [FLAKY_TEST], `base${i}`, i * 1000);
    const nowMs = 6000;
    // But THIS run's actual observed failure for that same test has a DIFFERENT signature.
    const newSignatureObservation = { testId: FLAKY_TEST.testId, signature: "AssertionError: this is a genuinely different failure reason" };
    const effectiveFingerprint = deriveEffectiveFingerprint(rolling!, "base5", [newSignatureObservation], nowMs);
    assert.deepEqual(effectiveFingerprint.knownFailures, [], "the new signature must NOT be quarantined just because the testId is familiar");

    const safety = decideRollingBaselineSafety({ ...IDENTITY, currentBaseSha: "base5", rolling, minTotalBaseRunsSampled: 3 });
    const activation = decideFinalActivation({
      selectionSafe: true,
      economicsBeneficial: true,
      baselineSafety: safety,
      fingerprint: effectiveFingerprint,
      fullObservedFailures: [newSignatureObservation.testId],
      selectedObservedFailures: [], // selected suite never observed this new-signature failure either
    });
    assert.deepEqual(activation.newFailuresInFull, [newSignatureObservation.testId]);
    assert.notEqual(activation.decision, "EXECUTE_SELECTIVELY");
    assert.equal(activation.decision, "REFUSE_NEW_FAILURE_NOT_PRESERVED");
  });

  it("case 3: a mutation-created failure in the selected suite is correctly preserved and eligible", () => {
    let rolling: RollingFingerprint | undefined;
    for (let i = 1; i <= 5; i++) rolling = mergeObservation(rolling, IDENTITY, [STABLE_TEST], `base${i}`, i * 1000); // unrelated known noise
    const nowMs = 6000;
    // The mutant run's full suite shows the stable known failure PLUS the real, deliberate new one.
    const fullObserved = [STABLE_TEST.testId, MUTATION_FAILURE.testId].map((testId) => ({ testId, signature: testId === STABLE_TEST.testId ? STABLE_TEST.signature : MUTATION_FAILURE.signature }));
    const effectiveFingerprint = deriveEffectiveFingerprint(rolling!, "base5", fullObserved, nowMs);
    assert.deepEqual(effectiveFingerprint.knownFailures, [STABLE_TEST.testId]); // only the truly-known one

    const safety = decideRollingBaselineSafety({ ...IDENTITY, currentBaseSha: "base5", rolling, minTotalBaseRunsSampled: 3 });
    const activation = decideFinalActivation({
      selectionSafe: true,
      economicsBeneficial: true,
      baselineSafety: safety,
      fingerprint: effectiveFingerprint,
      fullObservedFailures: [STABLE_TEST.testId, MUTATION_FAILURE.testId],
      selectedObservedFailures: [MUTATION_FAILURE.testId], // the selected suite's own real result: it caught the mutation
    });
    assert.deepEqual(activation.newFailuresInFull, [MUTATION_FAILURE.testId]);
    assert.deepEqual(activation.newFailuresMissedBySelection, []);
    assert.equal(activation.decision, "EXECUTE_SELECTIVELY");
  });
});

describe("classifyAgainstFingerprint integration sanity (existing pipeline, unmodified)", () => {
  it("a derived fingerprint composes correctly with the already-proven classifyAgainstFingerprint", () => {
    let rolling: RollingFingerprint | undefined;
    for (let i = 1; i <= 4; i++) rolling = mergeObservation(rolling, IDENTITY, [STABLE_TEST], `base${i}`, i * 1000);
    const fp = deriveEffectiveFingerprint(rolling!, "base4", [STABLE_TEST], 5000);
    const c = classifyAgainstFingerprint([STABLE_TEST.testId, "genuinely-new.spec.ts :: x"], fp);
    assert.deepEqual(c.knownFailures, [STABLE_TEST.testId]);
    assert.deepEqual(c.newFailures, ["genuinely-new.spec.ts :: x"]);
  });
});
