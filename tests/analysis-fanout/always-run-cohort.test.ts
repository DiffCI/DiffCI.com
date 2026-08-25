import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_COHORT_POLICY, selectAlwaysRunCohort } from "../../src/analysis-fanout/always-run-cohort.js";
import type { RollingFingerprint } from "../../src/analysis-fanout/rolling-fingerprint.js";

const IDENTITY = { repository: "deepseek-ai/deepseek-harness", branch: "main", environmentIdentity: "nonroot", testFamily: "unit", commandIdentity: "test" };

function rolling(tracked: RollingFingerprint["tracked"]): RollingFingerprint {
  return { ...IDENTITY, schemaVersion: 2, totalBaseRunsSampled: 10, baseShaHistory: ["a", "b", "c"], tracked, updatedAtMs: 1000 };
}

describe("selectAlwaysRunCohort", () => {
  it("returns empty when no rolling fingerprint exists yet", () => {
    const r = selectAlwaysRunCohort(undefined);
    assert.deepEqual(r.files, []);
    assert.deepEqual(r.sourceEntries, []);
  });

  it("excludes entries below minObservations - a single-sample entry is not high-signal enough", () => {
    const r = selectAlwaysRunCohort(
      rolling([{ testId: "a.spec.ts :: x", signature: "s", observations: [{ baseSha: "a", observedAtMs: 1 }] }]),
      { maxCohortSize: 5, minObservations: 2 },
    );
    assert.deepEqual(r.files, []);
  });

  it("extracts the FILE from a '<file> :: <fullName>' testId", () => {
    const r = selectAlwaysRunCohort(
      rolling([{ testId: "packages/x/tests/y.spec.ts :: some test name with :: in it too", signature: "s", observations: [{ baseSha: "a", observedAtMs: 1 }, { baseSha: "b", observedAtMs: 2 }] }]),
      { maxCohortSize: 5, minObservations: 2 },
    );
    assert.deepEqual(r.files, ["packages/x/tests/y.spec.ts"]);
  });

  it("falls back to the whole testId when there is no ' :: ' separator - never throws, never silently drops", () => {
    const r = selectAlwaysRunCohort(
      rolling([{ testId: "malformed-no-separator", signature: "s", observations: [{ baseSha: "a", observedAtMs: 1 }, { baseSha: "b", observedAtMs: 2 }] }]),
      { maxCohortSize: 5, minObservations: 2 },
    );
    assert.deepEqual(r.files, ["malformed-no-separator"]);
  });

  it("orders by observation count descending, ties broken by testId for determinism", () => {
    const r = selectAlwaysRunCohort(
      rolling([
        { testId: "z.spec.ts :: a", signature: "s", observations: [{ baseSha: "a", observedAtMs: 1 }, { baseSha: "b", observedAtMs: 2 }] }, // 2 obs
        { testId: "y.spec.ts :: b", signature: "s", observations: [{ baseSha: "a", observedAtMs: 1 }, { baseSha: "b", observedAtMs: 2 }, { baseSha: "c", observedAtMs: 3 }] }, // 3 obs
        { testId: "x.spec.ts :: c", signature: "s", observations: [{ baseSha: "a", observedAtMs: 1 }, { baseSha: "b", observedAtMs: 2 }] }, // 2 obs, ties with z
      ]),
      { maxCohortSize: 5, minObservations: 2 },
    );
    // y (3 obs) first, then x/z tied at 2 obs broken alphabetically by testId ("x.spec.ts..." < "z.spec.ts...")
    assert.deepEqual(r.files, ["y.spec.ts", "x.spec.ts", "z.spec.ts"]);
  });

  it("caps at maxCohortSize even when more eligible entries exist", () => {
    const tracked = Array.from({ length: 10 }, (_, i) => ({
      testId: `f${i}.spec.ts :: t`,
      signature: "s",
      observations: [{ baseSha: "a", observedAtMs: 1 }, { baseSha: "b", observedAtMs: 2 }],
    }));
    const r = selectAlwaysRunCohort(rolling(tracked), { maxCohortSize: 3, minObservations: 2 });
    assert.equal(r.files.length, 3);
  });

  it("a file with MULTIPLE tracked tests counts once toward the cap, not once per tracked test", () => {
    const r = selectAlwaysRunCohort(
      rolling([
        { testId: "shared.spec.ts :: a", signature: "s1", observations: [{ baseSha: "a", observedAtMs: 1 }, { baseSha: "b", observedAtMs: 2 }, { baseSha: "c", observedAtMs: 3 }] },
        { testId: "shared.spec.ts :: b", signature: "s2", observations: [{ baseSha: "a", observedAtMs: 1 }, { baseSha: "b", observedAtMs: 2 }] },
        { testId: "other.spec.ts :: c", signature: "s3", observations: [{ baseSha: "a", observedAtMs: 1 }, { baseSha: "b", observedAtMs: 2 }] },
      ]),
      { maxCohortSize: 2, minObservations: 2 },
    );
    assert.deepEqual(r.files, ["shared.spec.ts", "other.spec.ts"]); // shared.spec.ts counted ONCE despite 2 tracked entries
  });

  it("DEFAULT_COHORT_POLICY is usable as the implicit default", () => {
    const r = selectAlwaysRunCohort(rolling([{ testId: "a.spec.ts :: x", signature: "s", observations: [{ baseSha: "a", observedAtMs: 1 }, { baseSha: "b", observedAtMs: 2 }] }]));
    assert.deepEqual(r.files, ["a.spec.ts"]);
    assert.equal(DEFAULT_COHORT_POLICY.maxCohortSize > 0, true);
  });

  it("sourceEntries reports which testId/observationCount drove each file's inclusion, for audit", () => {
    const r = selectAlwaysRunCohort(
      rolling([{ testId: "a.spec.ts :: x", signature: "s", observations: [{ baseSha: "a", observedAtMs: 1 }, { baseSha: "b", observedAtMs: 2 }, { baseSha: "c", observedAtMs: 3 }] }]),
      { maxCohortSize: 5, minObservations: 2 },
    );
    assert.deepEqual(r.sourceEntries, [{ testId: "a.spec.ts :: x", file: "a.spec.ts", observationCount: 3 }]);
  });
});
