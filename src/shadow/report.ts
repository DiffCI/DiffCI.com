import type { FailureRecallRecord, ShadowAggregate, ShadowReport, ShadowRunRecord } from "./types.js";
import { aggregateFailureRecall } from "./failure-recall.js";

const DIFFCI_VERSION = "0.6.0-phase6";
const SCHEMA_VERSION = "diffci-shadow-report/1";

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

function median(values: number[]): number {
  return percentile(values.slice().sort((a, b) => a - b), 50);
}

function taskReductionForRecord(record: ShadowRunRecord): number {
  const total = record.actualTasks.length;
  const selected = record.proposedTasks.length;
  return total ? ((total - selected) / total) * 100 : 0;
}

function buildIdentity(record: ShadowRunRecord) {
  return {
    repository: record.ciEnvironment?.repository ?? "unknown",
    baseSha: record.commit.baseSha,
    headSha: record.commit.headSha,
    diffciVersion: DIFFCI_VERSION,
    schemaVersion: record.schemaVersion,
    logicalKey: `${record.commit.baseSha}:${record.commit.headSha}:${record.schemaVersion}:${DIFFCI_VERSION}`,
    executionKey: "local",
  };
}

function buildUniqueDelta(key: string, records: ShadowRunRecord[]) {
  const latest = records.sort((a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime())[0]!;
  const identity = latest.runIdentity || buildIdentity(latest);
  return {
    logicalKey: key,
    identity,
    mode: latest.plan.mode,
    taskReductionPercent: taskReductionForRecord(latest),
    measured: latest.measured,
    failureRecallRecords: latest.failureRecallRecords ?? [],
  };
}

export function buildShadowReport(
  records: ShadowRunRecord[],
  options: { repository?: string; malformedRecords?: number } = {},
): ShadowReport {
  const byLogicalKey = new Map<string, ShadowRunRecord[]>();
  for (const record of records) {
    const key = record.runIdentity?.logicalKey ?? buildIdentity(record).logicalKey;
    const arr = byLogicalKey.get(key) ?? [];
    arr.push(record);
    byLogicalKey.set(key, arr);
  }

  const uniqueDeltas = Array.from(byLogicalKey.entries()).map(([key, group]) => buildUniqueDelta(key, group));
  const uniqueRecords = uniqueDeltas.map((d) => byLogicalKey.get(d.logicalKey)!.sort((a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime())[0]!);

  const executions = records.length;
  const unique = uniqueDeltas.length;
  const retries = executions - unique;
  const duplicates = Math.max(0, executions - unique);
  const malformedRecords = options.malformedRecords ?? 0;
  const completeRecords = records.filter(
    (r) => r.runIdentity && (!r.baseline || r.baseline.status === "COMPLETE"),
  ).length;
  const incompleteRecords = executions - completeRecords;

  const fullModeCount = uniqueDeltas.filter((d) => d.mode === "FULL").length;
  const selectiveModeCount = unique - fullModeCount;

  const taskReductions = uniqueDeltas.map((d) => d.taskReductionPercent);
  const potentialRuntimeSavings = uniqueDeltas.map((d) => d.measured?.netPotentialTimeSavedMs).filter((v): v is number => typeof v === "number");
  const overheads = uniqueRecords.map((r) => r.timing.totalDiffCiOverheadMs).filter((v): v is number => typeof v === "number");

  const cacheHits = uniqueRecords.filter((r) => r.cacheMetrics?.cacheHit).length;
  const cacheMisses = unique - cacheHits;

  const pathBaselineFullCount = uniqueRecords.filter((r) => r.pathBaseline?.fallbackRequired).length;
  const diffCiFullCount = fullModeCount;

  const allFailures: FailureRecallRecord[] = records.flatMap((r) => r.failureRecallRecords ?? []);
  const recall = aggregateFailureRecall(allFailures);

  const aggregate: ShadowAggregate = {
    rawExecutions: executions,
    uniqueCommitDeltas: unique,
    workflowRetries: retries,
    duplicateAnalyses: duplicates,
    malformedRecords,
    completeRecords,
    incompleteRecords,
    fullModeCount,
    selectiveModeCount,
    pathBaselineFullCount,
    diffCiFullCount,
    medianPotentialTaskReductionPercent: median(taskReductions),
    medianMeasuredPotentialRuntimeReductionMs: potentialRuntimeSavings.length ? median(potentialRuntimeSavings) : undefined,
    medianDiffCiOverheadMs: median(overheads),
    cacheHitCount: cacheHits,
    cacheMissCount: cacheMisses,
    failedTasksObserved: recall.failedTasksObserved,
    failedTestsObserved: recall.failedTestsObserved,
    unsafeTaskMisses: recall.unsafeTaskMisses,
    unsafeTestMisses: recall.unsafeTestMisses,
    taskRecallPercent: recall.taskRecallPercent,
    testRecallPercent: recall.testRecallPercent,
  };

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    diffciVersion: DIFFCI_VERSION,
    repository: options.repository,
    aggregate,
    uniqueDeltas,
    rawExecutions: records,
    failureRecallRecords: allFailures,
    reliabilityEvents: records.flatMap((r) => r.reliabilityEvents ?? []),
  };
}
