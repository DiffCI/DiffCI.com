import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildShadowReport } from "../../src/shadow/report.js";
import type { ShadowRunRecord, ShadowRunIdentity } from "../../src/shadow/types.js";
import type { ExecutionPlan } from "../../src/planner/types.js";

function makeIdentity(overrides: Partial<ShadowRunIdentity> = {}): ShadowRunIdentity {
  const baseSha = overrides.baseSha ?? "base";
  const headSha = overrides.headSha ?? "head";
  const schemaVersion = overrides.schemaVersion ?? "diffci-shadow/1";
  const diffciVersion = overrides.diffciVersion ?? "0.6.0";
  return {
    repository: "owner/repo",
    baseSha,
    headSha,
    diffciVersion,
    schemaVersion,
    logicalKey: `${baseSha}:${headSha}:${schemaVersion}:${diffciVersion}`,
    executionKey: "1.1",
    ...overrides,
  };
}

function makePlan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    version: "6.0.0",
    mode: "SELECTIVE",
    tasks: [
      { id: "typecheck", command: "tsc --noEmit", category: "typecheck", status: "RUN", reason: "src changed", alwaysRun: false, triggeredBy: ["src/foo.ts"] },
      { id: "test:scripts", command: "npm run test:scripts", category: "test", status: "SKIP_CANDIDATE", reason: "no match", alwaysRun: false, triggeredBy: [] },
      { id: "test:security", command: "npm run test:security", category: "security", status: "ALWAYS_RUN", reason: "always-run", alwaysRun: true, triggeredBy: [] },
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

function makeRecord(identity: ShadowRunIdentity, plan: ExecutionPlan): ShadowRunRecord {
  const actualTasks = plan.tasks.map((t) => t.id);
  const proposedTasks = plan.tasks.filter((t) => t.status !== "SKIP_CANDIDATE").map((t) => t.id);
  return {
    schemaVersion: identity.schemaVersion,
    recordedAt: new Date().toISOString(),
    runIdentity: identity,
    commit: { baseSha: identity.baseSha, headSha: identity.headSha },
    changedFiles: ["src/foo.ts"],
    impactFallback: plan.safety.fallbackRequired,
    fallbackReasons: plan.fallbackReasons,
    plan,
    actualTasks,
    proposedTasks,
    actualTestCount: 2,
    selectedTestCount: plan.selectedTests.length,
    timing: {
      gitAnalysisMs: 10,
      graphConstructionMs: 100,
      impactAnalysisMs: 20,
      plannerMs: 5,
      totalDiffCiOverheadMs: 135,
    },
  };
}

describe("shadow report", () => {
  it("deduplicates by logical key", () => {
    const id = makeIdentity();
    const records = [
      makeRecord(id, makePlan()),
      makeRecord({ ...id, executionKey: "1.2", githubRunAttempt: 2 }, makePlan()),
      makeRecord(makeIdentity({ baseSha: "other" }), makePlan()),
    ];
    const report = buildShadowReport(records);
    assert.strictEqual(report.aggregate.rawExecutions, 3);
    assert.strictEqual(report.aggregate.uniqueCommitDeltas, 2);
    assert.strictEqual(report.aggregate.workflowRetries, 1);
    assert.strictEqual(report.aggregate.duplicateAnalyses, 1);
  });

  it("records selective and full modes correctly", () => {
    const selective = makeRecord(makeIdentity({ headSha: "h1", logicalKey: "b:h1:s:v" }), makePlan());
    const fullPlan = makePlan({ mode: "FULL", safety: { graphConfidence: "COMPLETE", impactStatus: "FALLBACK", fallbackRequired: true } });
    const full = makeRecord(makeIdentity({ headSha: "h2", logicalKey: "b:h2:s:v" }), fullPlan);
    const report = buildShadowReport([selective, full]);
    assert.strictEqual(report.aggregate.selectiveModeCount, 1);
    assert.strictEqual(report.aggregate.fullModeCount, 1);
    assert.strictEqual(report.aggregate.diffCiFullCount, 1);
  });

  it("computes median task reduction", () => {
    const tasks = [
      { id: "a", command: "a", category: "test" as const, status: "RUN" as const, reason: "", alwaysRun: false, triggeredBy: [] },
      { id: "b", command: "b", category: "test" as const, status: "SKIP_CANDIDATE" as const, reason: "", alwaysRun: false, triggeredBy: [] },
      { id: "c", command: "c", category: "test" as const, status: "SKIP_CANDIDATE" as const, reason: "", alwaysRun: false, triggeredBy: [] },
    ];
    const plan = makePlan({ tasks, selectedTests: [], skippedTests: [] });
    const record = makeRecord(makeIdentity(), plan);
    const report = buildShadowReport([record]);
    assert.strictEqual(report.aggregate.medianPotentialTaskReductionPercent, (2 / 3) * 100);
  });
});
