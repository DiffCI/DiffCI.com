import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyAgainstFingerprint, decideBaselineSafety } from "../../src/analysis-fanout/baseline-fingerprint-gate.js";

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

describe("decideBaselineSafety (differential-baseline safety gate)", () => {
  it("REFUSE_NO_FINGERPRINT is the ordinary state for a repository this policy has never run against - not an error", () => {
    const r = decideBaselineSafety({
      repository: "deepseek-ai/deepseek-harness",
      currentBaseSha: REAL_2808_BASE_SHA,
      fingerprint: undefined,
      maxFingerprintAgeMs: 24 * 3_600_000,
      nowMs: 1_000_000,
    });
    assert.equal(r.decision, "REFUSE_NO_FINGERPRINT");
  });

  it("REFUSE_WRONG_BASE - a fingerprint for a different base is never reused, however recent", () => {
    const r = decideBaselineSafety({
      repository: "deepseek-ai/deepseek-harness",
      currentBaseSha: REAL_2808_BASE_SHA,
      fingerprint: {
        repository: "deepseek-ai/deepseek-harness",
        baseSha: "b70f27f764e014287faef04858e00822c4d138f2", // PR #2760's base, a DIFFERENT commit
        knownFailures: REAL_2808_STABLE_FAILURES,
        establishedAtMs: 1_000_000,
      },
      maxFingerprintAgeMs: 24 * 3_600_000,
      nowMs: 1_000_100,
    });
    assert.equal(r.decision, "REFUSE_WRONG_BASE");
  });

  it("REFUSE_STALE_FINGERPRINT - a matching-base fingerprint older than the trust window is not reused", () => {
    const oneDayMs = 24 * 3_600_000;
    const r = decideBaselineSafety({
      repository: "deepseek-ai/deepseek-harness",
      currentBaseSha: REAL_2808_BASE_SHA,
      fingerprint: {
        repository: "deepseek-ai/deepseek-harness",
        baseSha: REAL_2808_BASE_SHA,
        knownFailures: REAL_2808_STABLE_FAILURES,
        establishedAtMs: 0,
      },
      maxFingerprintAgeMs: oneDayMs,
      nowMs: oneDayMs + 1,
    });
    assert.equal(r.decision, "REFUSE_STALE_FINGERPRINT");
    assert.equal(r.fingerprintAgeMs, oneDayMs + 1);
  });

  it("ACTIVATE - a fresh, matching-base fingerprint (the real PR #2808 case from Report 14) is trusted", () => {
    const oneDayMs = 24 * 3_600_000;
    const r = decideBaselineSafety({
      repository: "deepseek-ai/deepseek-harness",
      currentBaseSha: REAL_2808_BASE_SHA,
      fingerprint: {
        repository: "deepseek-ai/deepseek-harness",
        baseSha: REAL_2808_BASE_SHA,
        knownFailures: REAL_2808_STABLE_FAILURES,
        establishedAtMs: 1_000_000,
      },
      maxFingerprintAgeMs: oneDayMs,
      nowMs: 1_000_000 + 60_000, // 1 minute later
    });
    assert.equal(r.decision, "ACTIVATE");
    assert.equal(r.fingerprintAgeMs, 60_000);
  });

  it("exactly at the trust-window boundary is still trusted (>, not >=)", () => {
    const r = decideBaselineSafety({
      repository: "x/y",
      currentBaseSha: "a".repeat(40),
      fingerprint: { repository: "x/y", baseSha: "a".repeat(40), knownFailures: [], establishedAtMs: 0 },
      maxFingerprintAgeMs: 1000,
      nowMs: 1000,
    });
    assert.equal(r.decision, "ACTIVATE");
  });
});

describe("classifyAgainstFingerprint", () => {
  it("real PR #2808 scenario: 6 known pre-existing failures classify as known, not new - merge is 'clean' by this policy", () => {
    const fingerprint = {
      repository: "deepseek-ai/deepseek-harness",
      baseSha: REAL_2808_BASE_SHA,
      knownFailures: REAL_2808_STABLE_FAILURES,
      establishedAtMs: 0,
    };
    // The merge-SHA full run's own observed failures (Report 14): the 6 stable ones, unchanged.
    const observed = REAL_2808_STABLE_FAILURES;
    const c = classifyAgainstFingerprint(observed, fingerprint);
    assert.deepEqual(c.knownFailures, REAL_2808_STABLE_FAILURES);
    assert.deepEqual(c.newFailures, []);
    assert.equal(c.clean, true);
  });

  it("a genuinely new failure (the real mutation-caused frontend-static.spec.ts failure) is correctly classified as new, not clean", () => {
    const fingerprint = {
      repository: "deepseek-ai/deepseek-harness",
      baseSha: REAL_2808_BASE_SHA,
      knownFailures: REAL_2808_STABLE_FAILURES,
      establishedAtMs: 0,
    };
    const realNewFailure = "frontend-static/tests/frontend-static.spec.ts :: real Loader composition serves explicit index entries and files while preserving HTTP error semantics";
    const observed = [...REAL_2808_STABLE_FAILURES, realNewFailure];
    const c = classifyAgainstFingerprint(observed, fingerprint);
    assert.deepEqual(c.newFailures, [realNewFailure]);
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
    const c = classifyAgainstFingerprint([], { repository: "x/y", baseSha: "a".repeat(40), knownFailures: ["a :: b"], establishedAtMs: 0 });
    assert.equal(c.clean, true);
  });
});
