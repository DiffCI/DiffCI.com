import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildFailureRecallRecords, aggregateFailureRecall } from "../../src/shadow/failure-recall.js";
import type { BaselineEvidence } from "../../src/shadow/types.js";
import type { ExecutionPlan } from "../../src/planner/types.js";

function makePlan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    version: "6.0.0",
    mode: "SELECTIVE",
    tasks: [
      { id: "typecheck", command: "tsc --noEmit", category: "typecheck", status: "RUN", reason: "", alwaysRun: false, triggeredBy: [] },
      { id: "test:scripts", command: "npm run test:scripts", category: "test", status: "SKIP_CANDIDATE", reason: "", alwaysRun: false, triggeredBy: [] },
      { id: "test:security", command: "npm run test:security", category: "security", status: "ALWAYS_RUN", reason: "", alwaysRun: true, triggeredBy: [] },
    ],
    selectedTests: ["src/security.test.ts"],
    skippedTests: ["src/other.test.ts"],
    alwaysRunTasks: ["test:security"],
    fallbackReasons: [],
    evidence: [],
    safety: { graphConfidence: "COMPLETE", impactStatus: "SAFE_TO_PROPOSE", fallbackRequired: false },
    commandSpecs: [],
    ...overrides,
  };
}

function makeBaseline(): BaselineEvidence {
  return {
    repository: "owner/repo",
    headSha: "head",
    status: "COMPLETE",
    fullRunsObserved: [],
    jobs: [
      {
        jobId: 1,
        jobName: "check",
        status: "completed",
        conclusion: "failure",
        steps: [
          { name: "Run typecheck", status: "completed", conclusion: "failure", durationMs: 1000 },
          { name: "Run script tests", status: "completed", conclusion: "success", durationMs: 500 },
        ],
      },
    ],
    failedJobNames: ["check"],
    failedTaskIds: [],
  };
}

describe("failure recall", () => {
  it("flags unsafe task miss when failed task is a skip candidate", () => {
    const plan = makePlan({
      tasks: [
        { id: "typecheck", command: "", category: "typecheck", status: "SKIP_CANDIDATE", reason: "", alwaysRun: false, triggeredBy: [] },
        { id: "test:security", command: "", category: "security", status: "ALWAYS_RUN", reason: "", alwaysRun: true, triggeredBy: [] },
      ],
    });
    const records = buildFailureRecallRecords(plan, makeBaseline(), ["src/foo.ts"]);
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0]?.failureType, "task");
    assert.strictEqual(records[0]?.target, "typecheck");
    assert.strictEqual(records[0]?.selectedByDiffCI, false);
  });

  it("flags failed test not selected as unsafe test miss", () => {
    const plan = makePlan({ selectedTests: ["src/other.test.ts"], skippedTests: ["src/security.test.ts"] });
    const records = buildFailureRecallRecords(plan, makeBaseline(), ["src/foo.ts"], undefined, ["src/security.test.ts"]);
    const miss = records.find((r) => r.failureType === "test");
    assert.ok(miss);
    assert.strictEqual(miss?.selectedByDiffCI, false);
  });

  it("aggregates recall correctly", () => {
    const records = [
      { failureType: "task" as const, target: "a", selectedByDiffCI: true, diffCIMode: "SELECTIVE" as const, relatedChangedFiles: [] },
      { failureType: "task" as const, target: "b", selectedByDiffCI: false, diffCIMode: "SELECTIVE" as const, relatedChangedFiles: [] },
    ];
    const agg = aggregateFailureRecall(records);
    assert.strictEqual(agg.failedTasksObserved, 2);
    assert.strictEqual(agg.unsafeTaskMisses, 1);
    assert.strictEqual(agg.taskRecallPercent, 50);
  });
});
