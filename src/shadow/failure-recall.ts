import type { ExecutionPlan } from "../planner/types.js";
import type { BaselineEvidence, FailureRecallRecord, ShadowRunIdentity } from "./types.js";
import { failedTaskIds } from "./task-mapping.js";

export function buildFailureRecallRecords(
  plan: ExecutionPlan,
  baseline: BaselineEvidence,
  changedFiles: string[],
  identity?: ShadowRunIdentity,
  failedTestNames?: string[],
): FailureRecallRecord[] {
  const records: FailureRecallRecord[] = [];
  const taskIds = failedTaskIds(baseline, plan.tasks);
  for (const taskId of taskIds) {
    const planTask = plan.tasks.find((t) => t.id === taskId);
    const skipped = planTask?.status === "SKIP_CANDIDATE";
    records.push({
      runIdentity: identity,
      failureType: "task",
      target: taskId,
      selectedByDiffCI: !skipped,
      diffCIMode: plan.mode,
      relatedChangedFiles: changedFiles,
      planTaskStatus: planTask?.status,
    });
  }
  for (const testName of failedTestNames ?? []) {
    const selected = plan.selectedTests.includes(testName);
    records.push({
      runIdentity: identity,
      failureType: "test",
      target: testName,
      selectedByDiffCI: selected,
      diffCIMode: plan.mode,
      relatedChangedFiles: changedFiles,
    });
  }
  return records;
}

export function aggregateFailureRecall(records: FailureRecallRecord[]) {
  const taskFailures = records.filter((r) => r.failureType === "task");
  const testFailures = records.filter((r) => r.failureType === "test");
  const failedTasksObserved = taskFailures.length;
  const failedTestsObserved = testFailures.length;
  const unsafeTaskMisses = taskFailures.filter((r) => !r.selectedByDiffCI).length;
  const unsafeTestMisses = testFailures.filter((r) => !r.selectedByDiffCI).length;
  return {
    failedTasksObserved,
    failedTestsObserved,
    unsafeTaskMisses,
    unsafeTestMisses,
    taskRecallPercent: failedTasksObserved ? ((failedTasksObserved - unsafeTaskMisses) / failedTasksObserved) * 100 : undefined,
    testRecallPercent: failedTestsObserved ? ((failedTestsObserved - unsafeTestMisses) / failedTestsObserved) * 100 : undefined,
  };
}
