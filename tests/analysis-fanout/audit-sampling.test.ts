import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_AUDIT_SAMPLING_POLICY, decideAuditSampling } from "../../src/analysis-fanout/audit-sampling.js";

describe("decideAuditSampling", () => {
  it("is deterministic - the SAME seed under the SAME policy always produces the SAME decision", () => {
    const a = decideAuditSampling("c71ff384cc80f8cfba5f364c5e2fefec1d69f28d", { auditFraction: 0.1 });
    const b = decideAuditSampling("c71ff384cc80f8cfba5f364c5e2fefec1d69f28d", { auditFraction: 0.1 });
    assert.deepEqual(a, b);
  });

  it("hashValue is always in [0, 1)", () => {
    for (const seed of ["a", "b", "c", "some-merge-sha", "", "1234567890abcdef"]) {
      const r = decideAuditSampling(seed, { auditFraction: 0.1 });
      assert.ok(r.hashValue >= 0 && r.hashValue < 1, `${seed} -> ${r.hashValue}`);
    }
  });

  it("auditFraction 0 never samples, auditFraction 1 always samples", () => {
    const seeds = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    for (const s of seeds) {
      assert.equal(decideAuditSampling(s, { auditFraction: 0 }).sampled, false);
      assert.equal(decideAuditSampling(s, { auditFraction: 1 }).sampled, true);
    }
  });

  it("different seeds are not trivially correlated - a real spread of mergeSha-like seeds produces a mix of true/false at a moderate fraction", () => {
    const seeds = Array.from({ length: 200 }, (_, i) => `merge-sha-${i}-${"abcdef0123456789".slice(i % 16, (i % 16) + 8)}`);
    const results = seeds.map((s) => decideAuditSampling(s, { auditFraction: 0.5 }).sampled);
    const sampledCount = results.filter(Boolean).length;
    // Not asserting an exact count (this is a hash, not a true RNG with guaranteed statistical properties) -
    // just that it isn't degenerate (all-true or all-false) at a 50% target fraction over 200 varied seeds.
    assert.ok(sampledCount > 40 && sampledCount < 160, `expected a real mix, got ${sampledCount}/200 sampled`);
  });

  it("policyFraction on the result echoes the input policy, for audit", () => {
    const r = decideAuditSampling("x", { auditFraction: 0.25 });
    assert.equal(r.policyFraction, 0.25);
  });

  it("DEFAULT_AUDIT_SAMPLING_POLICY is usable as the implicit default", () => {
    const withDefault = decideAuditSampling("some-seed");
    const explicit = decideAuditSampling("some-seed", DEFAULT_AUDIT_SAMPLING_POLICY);
    assert.deepEqual(withDefault, explicit);
  });
});
