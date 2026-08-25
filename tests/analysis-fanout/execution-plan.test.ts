import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildEffectiveExecutionPlan, cohortOnlyFiles } from "../../src/analysis-fanout/execution-plan.js";

describe("buildEffectiveExecutionPlan", () => {
  it("empty cohort - effectiveFiles equals affectedFiles exactly, every entry provenance AFFECTED", () => {
    const p = buildEffectiveExecutionPlan(["a.spec.ts", "b.spec.ts"], []);
    assert.deepEqual(p.effectiveFiles, ["a.spec.ts", "b.spec.ts"]);
    assert.deepEqual(p.provenance.map((e) => e.provenance), ["AFFECTED", "AFFECTED"]);
  });

  it("empty affected selection - effectiveFiles equals cohortFiles exactly, every entry provenance ALWAYS_RUN", () => {
    const p = buildEffectiveExecutionPlan([], ["c.spec.ts"]);
    assert.deepEqual(p.effectiveFiles, ["c.spec.ts"]);
    assert.equal(p.provenance[0]!.provenance, "ALWAYS_RUN");
  });

  it("a file in BOTH affected and cohort appears ONCE in effectiveFiles, tagged BOTH - not duplicated", () => {
    const p = buildEffectiveExecutionPlan(["shared.spec.ts", "a.spec.ts"], ["shared.spec.ts", "c.spec.ts"]);
    assert.equal(p.effectiveFiles.filter((f) => f === "shared.spec.ts").length, 1);
    assert.equal(p.provenance.find((e) => e.file === "shared.spec.ts")!.provenance, "BOTH");
    assert.equal(p.provenance.find((e) => e.file === "a.spec.ts")!.provenance, "AFFECTED");
    assert.equal(p.provenance.find((e) => e.file === "c.spec.ts")!.provenance, "ALWAYS_RUN");
  });

  it("dedupes WITHIN affectedFiles and WITHIN cohortFiles too, not just across them", () => {
    const p = buildEffectiveExecutionPlan(["a.spec.ts", "a.spec.ts"], ["b.spec.ts", "b.spec.ts"]);
    assert.deepEqual(p.affectedFiles, ["a.spec.ts"]);
    assert.deepEqual(p.cohortFiles, ["b.spec.ts"]);
    assert.deepEqual(p.effectiveFiles, ["a.spec.ts", "b.spec.ts"]);
  });

  it("effectiveFiles is sorted deterministically regardless of input order", () => {
    const p1 = buildEffectiveExecutionPlan(["z.spec.ts"], ["a.spec.ts"]);
    const p2 = buildEffectiveExecutionPlan(["a.spec.ts"], ["z.spec.ts"]); // roles swapped between the two inputs
    assert.deepEqual(p1.effectiveFiles, p2.effectiveFiles);
    assert.deepEqual(p1.effectiveFiles, ["a.spec.ts", "z.spec.ts"]);
  });

  it("both empty - a genuinely empty plan, not an error", () => {
    const p = buildEffectiveExecutionPlan([], []);
    assert.deepEqual(p.effectiveFiles, []);
    assert.deepEqual(p.provenance, []);
  });
});

describe("cohortOnlyFiles", () => {
  it("returns exactly the ALWAYS_RUN-provenance files, excluding AFFECTED and BOTH", () => {
    const p = buildEffectiveExecutionPlan(["affected-only.spec.ts", "shared.spec.ts"], ["shared.spec.ts", "cohort-only.spec.ts"]);
    assert.deepEqual(cohortOnlyFiles(p), ["cohort-only.spec.ts"]);
  });

  it("empty when the cohort added nothing beyond the affected selection", () => {
    const p = buildEffectiveExecutionPlan(["a.spec.ts"], ["a.spec.ts"]); // fully overlapping - cohort picked the same file
    assert.deepEqual(cohortOnlyFiles(p), []);
  });
});
