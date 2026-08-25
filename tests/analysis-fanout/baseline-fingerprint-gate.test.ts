import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyAgainstFingerprint, decideBaselineSafety, decideFinalActivation, type BaselineFingerprint } from "../../src/analysis-fanout/baseline-fingerprint-gate.js";

// Real evidence from this mission (Report 14): the 6 failures confirmed identical at PR #2808's base AND
// merge SHA under non-root execution - a genuine trusted fingerprint, not a fabricated fixture.
const REAL_2808_BASE_SHA = "ed3ef7aceef1a567394b788c64b23fa6f96a7af3";
const REAL_2808_STABLE_FAILURES = [
  "subprocess-local/tests/process-exit.spec.ts :: synchronous cleanup on host exit removes an ordinary managed tree after 'direct'",
  "subprocess-local/tests/process-exit.spec.ts :: synchronous cleanup on host exit removes an ordinary managed tree after 'uncaught-exception'",
  "subprocess-local/tests/process-exit.spec.ts :: synchronous cleanup on host exit removes an ordinary managed tree after 'unhandled-rejection'",
  "subprocess-local/tests/process-exit.spec.ts :: synchronous cleanup on host exit removes a terminal root and descendant after direct exit",
  "deepseek-ai__deepseek-harness/scripts/install-lefthook.spec.ts :: worktree-local Lefthook installer replaces the owned hook path Git copies into a newly added worktree",
  "terminal-bash/tests/local.spec.ts :: terminal-bash real shell cancels a slow-starting raw-mode foreground process with a real SIGINT",
];
const REAL_MUTATION_FAILURE = "frontend-static/tests/frontend-static.spec.ts :: real Loader composition serves explicit index entries and files while preserving HTTP error semantics";

function fingerprint(overrides: Partial<BaselineFingerprint> = {}): BaselineFingerprint {
  return {
    repository: "deepseek-ai/deepseek-harness",
    branch: "main",
    baseSha: REAL_2808_BASE_SHA,
    environmentIdentity: "nonroot",
    testFamily: "unit",
    commandIdentity: "test",
    knownFailures: REAL_2808_STABLE_FAILURES,
    establishedAtMs: 1_000_000,
    ...overrides,
  };
}

function safetyInput(overrides: Record<string, unknown> = {}) {
  return {
    repository: "deepseek-ai/deepseek-harness",
    branch: "main",
    currentBaseSha: REAL_2808_BASE_SHA,
    environmentIdentity: "nonroot",
    testFamily: "unit",
    commandIdentity: "test",
    fingerprint: fingerprint(),
    maxFingerprintAgeMs: 24 * 3_600_000,
    nowMs: 1_000_000 + 60_000,
    ...overrides,
  };
}

describe("decideBaselineSafety (differential-baseline safety gate)", () => {
  it("REFUSE_NO_FINGERPRINT is the ordinary state for a repository this policy has never run against - not an error", () => {
    const r = decideBaselineSafety(safetyInput({ fingerprint: undefined }));
    assert.equal(r.decision, "REFUSE_NO_FINGERPRINT");
  });

  it("REFUSE_WRONG_BASE - a fingerprint for a different base is never reused, however recent", () => {
    const r = decideBaselineSafety(safetyInput({
      fingerprint: fingerprint({ baseSha: "b70f27f764e014287faef04858e00822c4d138f2" }), // PR #2760's base
    }));
    assert.equal(r.decision, "REFUSE_WRONG_BASE");
  });

  it("REFUSE_WRONG_BASE - a fingerprint for a different repository is never reused even with a matching SHA", () => {
    const r = decideBaselineSafety(safetyInput({ fingerprint: fingerprint({ repository: "calcom/cal.diy" }) }));
    assert.equal(r.decision, "REFUSE_WRONG_BASE");
  });

  it("REFUSE_IDENTITY_MISMATCH - matching base but a different execution environment (root vs non-root, Report 13/14's own real finding) is never trusted", () => {
    const r = decideBaselineSafety(safetyInput({ environmentIdentity: "root" })); // fingerprint itself stays "nonroot"
    assert.equal(r.decision, "REFUSE_IDENTITY_MISMATCH");
    assert.match(r.explanation, /environmentIdentity/);
  });

  it("REFUSE_IDENTITY_MISMATCH - matching base but a different command shape is never trusted", () => {
    const r = decideBaselineSafety(safetyInput({ commandIdentity: "test --no-isolate" }));
    assert.equal(r.decision, "REFUSE_IDENTITY_MISMATCH");
    assert.match(r.explanation, /commandIdentity/);
  });

  it("REFUSE_IDENTITY_MISMATCH - matching base but a different branch is never trusted", () => {
    const r = decideBaselineSafety(safetyInput({ branch: "release/1.0" }));
    assert.equal(r.decision, "REFUSE_IDENTITY_MISMATCH");
    assert.match(r.explanation, /branch/);
  });

  it("REFUSE_STALE_FINGERPRINT - a fully-matching fingerprint older than the trust window is not reused", () => {
    const oneDayMs = 24 * 3_600_000;
    const r = decideBaselineSafety(safetyInput({
      fingerprint: fingerprint({ establishedAtMs: 0 }),
      maxFingerprintAgeMs: oneDayMs,
      nowMs: oneDayMs + 1,
    }));
    assert.equal(r.decision, "REFUSE_STALE_FINGERPRINT");
    assert.equal(r.fingerprintAgeMs, oneDayMs + 1);
  });

  it("ACTIVATE - a fresh, fully-matching fingerprint (the real PR #2808 case from Report 14) is trusted", () => {
    const r = decideBaselineSafety(safetyInput());
    assert.equal(r.decision, "ACTIVATE");
    assert.equal(r.fingerprintAgeMs, 60_000);
  });

  it("exactly at the trust-window boundary is still trusted (>, not >=)", () => {
    const r = decideBaselineSafety(safetyInput({
      fingerprint: fingerprint({ establishedAtMs: 0 }),
      maxFingerprintAgeMs: 1000,
      nowMs: 1000,
    }));
    assert.equal(r.decision, "ACTIVATE");
  });
});

describe("classifyAgainstFingerprint", () => {
  it("real PR #2808 scenario: 6 known pre-existing failures classify as known, not new - merge is 'clean' by this policy", () => {
    const c = classifyAgainstFingerprint(REAL_2808_STABLE_FAILURES, fingerprint());
    assert.deepEqual(c.knownFailures, REAL_2808_STABLE_FAILURES);
    assert.deepEqual(c.newFailures, []);
    assert.equal(c.clean, true);
  });

  it("a genuinely new failure (the real mutation-caused frontend-static.spec.ts failure) is correctly classified as new, not clean", () => {
    const observed = [...REAL_2808_STABLE_FAILURES, REAL_MUTATION_FAILURE];
    const c = classifyAgainstFingerprint(observed, fingerprint());
    assert.deepEqual(c.newFailures, [REAL_MUTATION_FAILURE]);
    assert.equal(c.knownFailures.length, 6);
    assert.equal(c.clean, false);
  });

  it("an undefined fingerprint treats every observed failure as new - the conservative default REFUSE_* is meant to pair with, not a silent 'assume clean'", () => {
    const c = classifyAgainstFingerprint(["some/test.spec.ts :: anything"], undefined);
    assert.deepEqual(c.newFailures, ["some/test.spec.ts :: anything"]);
    assert.equal(c.knownFailures.length, 0);
    assert.equal(c.clean, false);
  });

  it("no observed failures at all is trivially clean regardless of fingerprint content", () => {
    const c = classifyAgainstFingerprint([], fingerprint());
    assert.equal(c.clean, true);
  });
});

describe("decideFinalActivation (hard-wired composed activation rule)", () => {
  it("REFUSE_SELECTION_UNSAFE short-circuits before economics/baseline are even considered", () => {
    const r = decideFinalActivation({
      selectionSafe: false,
      economicsBeneficial: true,
      baselineSafety: { decision: "ACTIVATE", explanation: "" },
      fingerprint: fingerprint(),
      fullObservedFailures: [],
      selectedObservedFailures: [],
    });
    assert.equal(r.decision, "REFUSE_SELECTION_UNSAFE");
  });

  it("REFUSE_ECONOMICS_NOT_BENEFICIAL when selection is safe but economics is not", () => {
    const r = decideFinalActivation({
      selectionSafe: true,
      economicsBeneficial: false,
      baselineSafety: { decision: "ACTIVATE", explanation: "" },
      fingerprint: fingerprint(),
      fullObservedFailures: [],
      selectedObservedFailures: [],
    });
    assert.equal(r.decision, "REFUSE_ECONOMICS_NOT_BENEFICIAL");
  });

  it("REFUSE_BASELINE_UNSAFE when the baseline gate refuses and this run's own full suite wasn't clean either", () => {
    const r = decideFinalActivation({
      selectionSafe: true,
      economicsBeneficial: true,
      baselineSafety: { decision: "REFUSE_NO_FINGERPRINT", explanation: "no fingerprint" },
      fingerprint: undefined,
      fullObservedFailures: REAL_2808_STABLE_FAILURES, // real suite, still has failures, no fingerprint to excuse them
      selectedObservedFailures: [],
    });
    assert.equal(r.decision, "REFUSE_BASELINE_UNSAFE");
  });

  it("ACTIVATEs via a clean THIS-RUN full suite even with no fingerprint at all - baseline safety has two independent paths", () => {
    const r = decideFinalActivation({
      selectionSafe: true,
      economicsBeneficial: true,
      baselineSafety: { decision: "REFUSE_NO_FINGERPRINT", explanation: "no fingerprint" },
      fingerprint: undefined,
      fullObservedFailures: [], // genuinely clean this run
      selectedObservedFailures: [],
    });
    assert.equal(r.decision, "EXECUTE_SELECTIVELY");
  });

  it("EXECUTE_SELECTIVELY - the real PR #2808 baseline case: fingerprint activates, zero new failures anywhere", () => {
    const r = decideFinalActivation({
      selectionSafe: true,
      economicsBeneficial: true,
      baselineSafety: { decision: "ACTIVATE", explanation: "trusted" },
      fingerprint: fingerprint(),
      fullObservedFailures: REAL_2808_STABLE_FAILURES, // all 6 known, 0 new
      selectedObservedFailures: [],
    });
    assert.equal(r.decision, "EXECUTE_SELECTIVELY");
    assert.deepEqual(r.newFailuresInFull, []);
  });

  it("EXECUTE_SELECTIVELY - the real PR #2808 mutant case: a genuine new failure exists AND the selected suite caught it (recall preserved)", () => {
    const r = decideFinalActivation({
      selectionSafe: true,
      economicsBeneficial: true,
      baselineSafety: { decision: "ACTIVATE", explanation: "trusted" },
      fingerprint: fingerprint(),
      fullObservedFailures: [...REAL_2808_STABLE_FAILURES, REAL_MUTATION_FAILURE],
      selectedObservedFailures: [REAL_MUTATION_FAILURE], // the selected suite's own real result
    });
    assert.deepEqual(r.newFailuresInFull, [REAL_MUTATION_FAILURE]);
    assert.deepEqual(r.newFailuresMissedBySelection, []);
    assert.equal(r.decision, "EXECUTE_SELECTIVELY");
  });

  it("REFUSE_NEW_FAILURE_NOT_PRESERVED - a new failure the full suite observed but the selected suite's own results do not contain (the #2844 family-scope shape, generalized)", () => {
    const r = decideFinalActivation({
      selectionSafe: true,
      economicsBeneficial: true,
      baselineSafety: { decision: "ACTIVATE", explanation: "trusted" },
      fingerprint: fingerprint(),
      fullObservedFailures: [...REAL_2808_STABLE_FAILURES, REAL_MUTATION_FAILURE],
      selectedObservedFailures: [], // selected suite did NOT catch it
    });
    assert.equal(r.decision, "REFUSE_NEW_FAILURE_NOT_PRESERVED");
    assert.deepEqual(r.newFailuresMissedBySelection, [REAL_MUTATION_FAILURE]);
  });

  it("with no full-suite run at all (real production shape), the missed-failure check is trivially satisfied and the fingerprint alone carries the safety argument", () => {
    const r = decideFinalActivation({
      selectionSafe: true,
      economicsBeneficial: true,
      baselineSafety: { decision: "ACTIVATE", explanation: "trusted" },
      fingerprint: fingerprint(),
      fullObservedFailures: undefined,
      selectedObservedFailures: REAL_2808_STABLE_FAILURES.slice(0, 1), // e.g. a known failure happened to be in scope
    });
    assert.equal(r.decision, "EXECUTE_SELECTIVELY");
    assert.deepEqual(r.newFailuresInFull, []);
  });
});
