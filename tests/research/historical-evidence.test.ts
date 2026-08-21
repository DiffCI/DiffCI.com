import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chargeBudget, createRateBudget, hasBudgetFor, remainingBudget } from "../../src/research/historical/rate-budget.js";
import { collectHistoricalEvidenceForDelta, filterToTestCategoryTaskIds } from "../../src/research/historical/evidence-collector.js";
import type { ExecutionPlan } from "../../src/planner/types.js";
import type { BaselineEvidence } from "../../src/shadow/types.js";

describe("historical CI evidence - rate budget", () => {
  it("allows calls within the hourly cap and rejects once exhausted", () => {
    const now = 1_000_000;
    const budget = createRateBudget(10, now);
    assert.equal(hasBudgetFor(budget, 3, now), true);
    chargeBudget(budget, 8, now);
    assert.equal(remainingBudget(budget, now), 2);
    assert.equal(hasBudgetFor(budget, 3, now), false, "8 used + 3 requested > 10 cap");
    assert.equal(hasBudgetFor(budget, 2, now), true);
  });

  it("resets the window after an hour has elapsed", () => {
    const start = 0;
    const budget = createRateBudget(10, start);
    chargeBudget(budget, 10, start);
    assert.equal(hasBudgetFor(budget, 1, start + 30 * 60 * 1000), false, "still within the same hour");
    assert.equal(hasBudgetFor(budget, 1, start + 61 * 60 * 1000), true, "new rolling hour has started");
  });
});

const EMPTY_PLAN: ExecutionPlan = {
  version: "1",
  mode: "SELECTIVE",
  tasks: [
    { id: "test:unit", command: "npm test", category: "test", status: "RUN", reason: "matched", alwaysRun: false, triggeredBy: [] },
    { id: "test:e2e", command: "npm run e2e", category: "test", status: "SKIP_CANDIDATE", reason: "no match", alwaysRun: false, triggeredBy: [] },
  ],
  selectedTests: [],
  skippedTests: [],
  alwaysRunTasks: [],
  fallbackReasons: [],
  evidence: [],
  safety: { graphConfidence: "COMPLETE", impactStatus: "SAFE_TO_PROPOSE", fallbackRequired: false },
  commandSpecs: [],
};

function baseline(overrides: Partial<BaselineEvidence>): BaselineEvidence {
  return {
    repository: "owner/repo",
    headSha: "abc123",
    status: "UNAVAILABLE",
    fullRunsObserved: [],
    jobs: [],
    failedJobNames: [],
    failedTaskIds: [],
    apiCallsMade: 1,
    ...overrides,
  };
}

describe("historical CI evidence - collectHistoricalEvidenceForDelta", () => {
  it("returns UNAVAILABLE without calling the fetcher when the rate budget is exhausted", async () => {
    const budget = createRateBudget(2, 0);
    chargeBudget(budget, 2, 0);
    let fetchCalled = false;
    const result = await collectHistoricalEvidenceForDelta({
      repository: "owner/repo",
      headSha: "abc",
      plan: EMPTY_PLAN,
      pathSelectedTaskIds: [],
      changedFiles: [],
      budget,
      fetchFn: async () => {
        fetchCalled = true;
        return baseline({ status: "COMPLETE" });
      },
    });
    assert.equal(fetchCalled, false, "must not spend a real GitHub call once the budget is exhausted");
    assert.equal(result.status, "UNAVAILABLE");
    assert.equal(result.reason, "github_rate_limit");
  });

  it("classifies COMPLETE baseline status as MEASURABLE and computes unsafe misses from the plan", async () => {
    const budget = createRateBudget(50, 0);
    const result = await collectHistoricalEvidenceForDelta({
      repository: "owner/repo",
      headSha: "abc",
      plan: EMPTY_PLAN,
      pathSelectedTaskIds: ["test:unit", "test:e2e"], // PATH is coarser: selects everything
      changedFiles: ["src/a.ts"],
      budget,
      fetchFn: async () =>
        baseline({
          status: "COMPLETE",
          fullRunsObserved: [{ workflowPath: ".github/workflows/ci.yml", workflowRunId: 1, runNumber: 1, status: "completed", conclusion: "failure", htmlUrl: "" }],
          jobs: [{ jobId: 1, jobName: "test:e2e", status: "completed", conclusion: "failure" }],
          failedJobNames: ["test:e2e"],
        }),
    });

    assert.equal(result.status, "MEASURABLE");
    assert.deepEqual(result.failedTargets, ["test:e2e"]);
    assert.deepEqual(result.unsafeMissTargets, ["test:e2e"], "test:e2e was SKIP_CANDIDATE in the plan - DiffCI would have missed this real failure");
    assert.deepEqual(result.pathUnsafeMissTargets, [], "PATH selected everything, so it has no unsafe misses here");
  });

  it("classifies PARTIAL baseline status as PARTIALLY_MEASURABLE, never as fully MEASURABLE", async () => {
    const budget = createRateBudget(50, 0);
    const result = await collectHistoricalEvidenceForDelta({
      repository: "owner/repo",
      headSha: "abc",
      plan: EMPTY_PLAN,
      pathSelectedTaskIds: [],
      changedFiles: [],
      budget,
      fetchFn: async () => baseline({ status: "PARTIAL", completenessNotes: "failed to fetch jobs for run 42" }),
    });
    assert.equal(result.status, "PARTIALLY_MEASURABLE");
    assert.equal(result.reason, "failed to fetch jobs for run 42");
  });

  it("classifies a fetch error as UNAVAILABLE with the error captured in the reason, never silently swallowed", async () => {
    const budget = createRateBudget(50, 0);
    const result = await collectHistoricalEvidenceForDelta({
      repository: "owner/repo",
      headSha: "abc",
      plan: EMPTY_PLAN,
      pathSelectedTaskIds: [],
      changedFiles: [],
      budget,
      fetchFn: async () => {
        throw new Error("network down");
      },
    });
    assert.equal(result.status, "UNAVAILABLE");
    assert.match(result.reason ?? "", /network down/);
  });

  // Stage 1B regression test (2026-08-21, docs/research/2026-08-21-stage1b-*.md): reproduces the exact
  // mechanism behind 2 of Stage 1A's 8 confirmed non-genuine historical misses - a GitHub Actions job
  // whose NAME matches a test-category task (e.g. literally named "tests") but whose actual conclusion
  // reflects a non-test step (lint) bundled into the same job - the plan's own task category should
  // exclude it from unsafeMissTargets, not just its job name.
  it("excludes matched jobs from unsafe-miss targets when their task's category is not 'test'", async () => {
    const planWithLintJob: ExecutionPlan = {
      ...EMPTY_PLAN,
      tasks: [
        ...EMPTY_PLAN.tasks,
        { id: "ci::tests", command: "npm run lint && npm test", category: "lint", status: "SKIP_CANDIDATE", reason: "no match", alwaysRun: false, triggeredBy: [] },
      ],
    };
    const budget = createRateBudget(50, 0);
    const result = await collectHistoricalEvidenceForDelta({
      repository: "owner/repo",
      headSha: "abc",
      plan: planWithLintJob,
      pathSelectedTaskIds: [],
      changedFiles: [],
      budget,
      fetchFn: async () =>
        baseline({
          status: "COMPLETE",
          fullRunsObserved: [{ workflowPath: ".github/workflows/ci.yml", workflowRunId: 1, runNumber: 1, status: "completed", conclusion: "failure", htmlUrl: "" }],
          jobs: [{ jobId: 1, jobName: "ci::tests", status: "completed", conclusion: "failure" }],
          failedJobNames: ["ci::tests"],
        }),
    });

    assert.deepEqual(result.failedTargets, ["ci::tests"], "the raw match is still recorded, not hidden");
    assert.deepEqual(result.unsafeMissTargets, [], "a lint-category task must never count as a test-selection safety miss");
    assert.deepEqual(result.nonTestCategoryExcludedTargets, ["ci::tests"], "the exclusion is visible, not silent");
  });

  // Stage 1B regression test: reproduces the flakiness-check mechanism behind the other 3 confirmed
  // non-genuine misses (a live-network rate limit, an infrastructure outage, a flaky timing assertion) -
  // when checkFlakiness is enabled and the injected checker reports the same job succeeds on most
  // nearby commits, the candidate must be excluded from unsafeMissTargets, not counted as a real miss.
  it("excludes a candidate unsafe miss when the injected flakiness checker reports it as likely flaky", async () => {
    const budget = createRateBudget(50, 0);
    let flakinessCheckCalls = 0;
    const result = await collectHistoricalEvidenceForDelta({
      repository: "owner/repo",
      headSha: "abc",
      plan: EMPTY_PLAN,
      pathSelectedTaskIds: ["test:unit", "test:e2e"],
      changedFiles: [],
      budget,
      checkFlakiness: true,
      fetchFn: async () =>
        baseline({
          status: "COMPLETE",
          fullRunsObserved: [{ workflowPath: ".github/workflows/ci.yml", workflowRunId: 1, runNumber: 1, status: "completed", conclusion: "failure", htmlUrl: "" }],
          jobs: [{ jobId: 1, jobName: "test:e2e", status: "completed", conclusion: "failure" }],
          failedJobNames: ["test:e2e"],
        }),
      flakinessCheckFn: async () => {
        flakinessCheckCalls++;
        return { checked: true, nearbyCommitsChecked: 5, nearbySuccesses: 5, likelyFlaky: true };
      },
    });

    assert.equal(flakinessCheckCalls, 1, "must only check the one real candidate miss, not run unconditionally");
    assert.deepEqual(result.failedTargets, ["test:e2e"], "the raw match is still recorded");
    assert.deepEqual(result.unsafeMissTargets, [], "a job confirmed likely-flaky on nearby commits must not count as a real miss");
    assert.deepEqual(result.likelyFlakyExcludedTargets, ["test:e2e"], "the exclusion is visible, not silent");
  });

  it("does not run the flakiness check at all when checkFlakiness is left off (the default)", async () => {
    const budget = createRateBudget(50, 0);
    let flakinessCheckCalls = 0;
    const result = await collectHistoricalEvidenceForDelta({
      repository: "owner/repo",
      headSha: "abc",
      plan: EMPTY_PLAN,
      pathSelectedTaskIds: ["test:unit", "test:e2e"],
      changedFiles: [],
      budget,
      fetchFn: async () =>
        baseline({
          status: "COMPLETE",
          fullRunsObserved: [{ workflowPath: ".github/workflows/ci.yml", workflowRunId: 1, runNumber: 1, status: "completed", conclusion: "failure", htmlUrl: "" }],
          jobs: [{ jobId: 1, jobName: "test:e2e", status: "completed", conclusion: "failure" }],
          failedJobNames: ["test:e2e"],
        }),
      flakinessCheckFn: async () => {
        flakinessCheckCalls++;
        return { checked: true, nearbyCommitsChecked: 5, nearbySuccesses: 5, likelyFlaky: true };
      },
    });

    assert.equal(flakinessCheckCalls, 0, "checkFlakiness defaults to off - must never spend extra GitHub calls unless explicitly requested");
    assert.deepEqual(result.unsafeMissTargets, ["test:e2e"], "without flakiness checking the candidate is still a real miss");
  });

  it("charges the budget by the actual number of GitHub calls made, not just the reservation", async () => {
    const budget = createRateBudget(50, 0);
    await collectHistoricalEvidenceForDelta({
      repository: "owner/repo",
      headSha: "abc",
      plan: EMPTY_PLAN,
      pathSelectedTaskIds: [],
      changedFiles: [],
      budget,
      fetchFn: async () =>
        baseline({
          status: "COMPLETE",
          fullRunsObserved: [
            { workflowPath: "a.yml", workflowRunId: 1, runNumber: 1, status: "completed", conclusion: "success", htmlUrl: "" },
            { workflowPath: "b.yml", workflowRunId: 2, runNumber: 1, status: "completed", conclusion: "success", htmlUrl: "" },
          ],
          // 1 runs-list call + 2 jobs calls (one per observed run) = 3 - the real count a fetchBaselineEvidence
          // call would report for this shape (Task 2, 2026-08-21: charged verbatim, not recomputed - see
          // evidence-collector.ts's chargeBudget call).
          apiCallsMade: 3,
        }),
    });
    assert.equal(remainingBudget(budget, 0), 47);
  });
});

describe("filterToTestCategoryTaskIds - Stage 2C measurement-pipeline repair (2026-08-21)", () => {
  it("THE Stage 2B regression, end to end: a task shaped exactly like DiffCI.com's own 'check' job (category 'validation', hasTestCommand true) is now included", () => {
    const plan: ExecutionPlan = {
      ...EMPTY_PLAN,
      tasks: [{ id: ".github/workflows/ci.yml::check", command: "CI / check", category: "validation", status: "RUN", reason: "matched", alwaysRun: false, triggeredBy: [], hasTestCommand: true }],
    };
    const { testTargets, excludedNonTest } = filterToTestCategoryTaskIds([".github/workflows/ci.yml::check"], plan);
    assert.deepEqual(testTargets, [".github/workflows/ci.yml::check"], "Stage 2B's exact bug: this must no longer be silently excluded");
    assert.deepEqual(excludedNonTest, []);
  });

  it("a task with category 'validation' and hasTestCommand false (or absent) is still correctly excluded - the repair does not blanket-include every non-test task", () => {
    const plan: ExecutionPlan = {
      ...EMPTY_PLAN,
      tasks: [
        { id: "lint-only", command: "lint", category: "validation", status: "RUN", reason: "matched", alwaysRun: false, triggeredBy: [], hasTestCommand: false },
        { id: "no-signal-at-all", command: "unknown", category: "validation", status: "RUN", reason: "matched", alwaysRun: false, triggeredBy: [] }, // hasTestCommand omitted entirely, pre-fix shape
      ],
    };
    const { testTargets, excludedNonTest } = filterToTestCategoryTaskIds(["lint-only", "no-signal-at-all"], plan);
    assert.deepEqual(testTargets, []);
    assert.deepEqual(excludedNonTest, ["lint-only", "no-signal-at-all"]);
  });

  it("pre-existing category==='test' tasks are unaffected by this repair (no regression to the already-working path)", () => {
    const plan: ExecutionPlan = { ...EMPTY_PLAN, tasks: [{ id: "test:unit", command: "npm test", category: "test", status: "RUN", reason: "matched", alwaysRun: false, triggeredBy: [] }] };
    const { testTargets } = filterToTestCategoryTaskIds(["test:unit"], plan);
    assert.deepEqual(testTargets, ["test:unit"]);
  });
});
