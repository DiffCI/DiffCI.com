import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildBenchmarkReport, fromShadowRecord } from "../../src/shadow/benchmark.js";
import type { ExecutionPlan } from "../../src/planner/types.js";

function makePlan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    version: "5.0.0",
    mode: "SELECTIVE",
    tasks: [
      { id: "typecheck", command: "tsc --noEmit", category: "typecheck", status: "RUN", reason: "triggered", alwaysRun: false, triggeredBy: ["src/foo.ts"] },
      { id: "test:security", command: "npm run test:security", category: "security", status: "ALWAYS_RUN", reason: "always-run", alwaysRun: true, triggeredBy: [] },
      { id: "test:source", command: "npm run test:source", category: "test", status: "SKIP_CANDIDATE", reason: "no match", alwaysRun: false, triggeredBy: [] },
    ],
    selectedTests: ["src/foo.test.ts"],
    skippedTests: ["src/bar.test.ts"],
    alwaysRunTasks: ["test:security"],
    fallbackReasons: [],
    evidence: [],
    safety: { graphConfidence: "COMPLETE", impactStatus: "SAFE_TO_PROPOSE", fallbackRequired: false },
    commandSpecs: [],
    ...overrides,
  };
}

describe("shadow benchmark", () => {
  it("converts shadow record to benchmark run", () => {
    const plan = makePlan();
    const record = {
      commit: { baseSha: "base", headSha: "head" } as const,
      changedFiles: ["src/foo.ts"],
      plan,
    };
    const run = fromShadowRecord(record);

    assert.equal(run.commit.headSha, "head");
    assert.equal(run.commitCategory, "shared-library");
    assert.equal(run.baseline.testsTotal, 2);
    assert.equal(run.proposed.testsSelected, 1);
    assert.equal(run.proposed.tasksSelected, 2);
    assert.ok(run.metrics.testReductionPercent > 0);
  });

  it("treats fallback plan as full baseline", () => {
    const plan = makePlan({
      mode: "FULL",
      selectedTests: ["src/foo.test.ts", "src/bar.test.ts"],
      skippedTests: [],
      safety: { graphConfidence: "COMPLETE", impactStatus: "FALLBACK", fallbackRequired: true },
    });
    const record = {
      commit: { baseSha: "base", headSha: "head" } as const,
      changedFiles: ["package.json"],
      plan,
    };
    const run = fromShadowRecord(record);

    assert.equal(run.proposed.fallbackRequired, true);
    assert.equal(run.proposed.testsSelected, 2);
    assert.equal(run.metrics.testReductionPercent, 0);
    assert.equal(run.pathBaseline.testsSelected, 2); // path baseline fallback uses the full baseline from selected tests
  });

  it("computes aggregate stats over multiple runs", () => {
    const runs = [
      fromShadowRecord({ commit: { baseSha: "b1", headSha: "h1" }, changedFiles: ["src/a.ts"], plan: makePlan() }),
      fromShadowRecord({ commit: { baseSha: "b2", headSha: "h2" }, changedFiles: ["package.json"], plan: makePlan({
        mode: "FULL",
        selectedTests: ["src/foo.test.ts", "src/bar.test.ts"],
        skippedTests: [],
        safety: { graphConfidence: "COMPLETE", impactStatus: "FALLBACK", fallbackRequired: true },
      }) }),
    ];
    const report = buildBenchmarkReport(runs);

    assert.equal(report.sampleSize, 2);
    assert.equal(report.aggregate.totalCommits, 2);
    assert.equal(report.aggregate.selectiveCommits, 1);
    assert.equal(report.aggregate.fallbackCommits, 1);
    assert.ok(report.aggregateSelectiveOnly);
    assert.ok(report.categories.length > 0);
  });
});
