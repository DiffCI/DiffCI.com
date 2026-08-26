import { runPathBaseline } from "../planner/path-baseline.js";
import { runShadowAnalysis } from "./runner.js";
import { fetchBaselineEvidence } from "./github-baseline.js";
import { buildFailureRecallRecords } from "./failure-recall.js";
import { buildExplainArtifact } from "./explain.js";
import { buildTaskTimings, computeMeasuredMetrics } from "./task-mapping.js";
import type { ShadowRunIdentity, ShadowRunRecord, ReliabilityEvent } from "./types.js";

export interface ShadowExperimentOptions {
  repoPath: string;
  baseSha: string;
  headSha: string;
  excludeDirs?: string[];
  cacheDir?: string;
  repository?: string;
  githubRunId?: string;
  githubRunAttempt?: number;
  workflow?: string;
  eventName?: string;
  ref?: string;
  actor?: string;
  token?: string;
  diffciVersion?: string;
}

export interface ShadowExperimentResult {
  record: ShadowRunRecord;
  identity: ShadowRunIdentity;
}

const SCHEMA = "diffci-shadow/1";

function buildIdentity(options: ShadowExperimentOptions): ShadowRunIdentity {
  const diffciVersion = options.diffciVersion ?? "0.6.0-phase6";
  const logicalKey = `${options.baseSha}:${options.headSha}:${SCHEMA}:${diffciVersion}`;
  const executionKey = `${options.githubRunId ?? "local"}.${options.githubRunAttempt ?? 1}`;
  return {
    repository: options.repository ?? "local",
    baseSha: options.baseSha,
    headSha: options.headSha,
    githubRunId: options.githubRunId,
    githubRunAttempt: options.githubRunAttempt,
    workflow: options.workflow,
    eventName: options.eventName,
    ref: options.ref,
    diffciVersion,
    schemaVersion: SCHEMA,
    logicalKey,
    executionKey,
  };
}

function reliabilityEvent(stage: string, success: boolean, error?: unknown, durationMs?: number): ReliabilityEvent {
  return {
    stage,
    success,
    durationMs,
    errorMessage: error instanceof Error ? error.message : error ? String(error) : undefined,
  };
}

export async function runShadowExperiment(options: ShadowExperimentOptions): Promise<ShadowExperimentResult> {
  const identity = buildIdentity(options);
  const reliability: ReliabilityEvent[] = [];

  const record = await runShadowAnalysis({
    repoPath: options.repoPath,
    baseSha: options.baseSha,
    headSha: options.headSha,
    excludeDirs: options.excludeDirs,
    cacheDir: options.cacheDir,
  });

  record.runIdentity = identity;
  record.schemaVersion = SCHEMA;
  record.ciEnvironment = {
    provider: options.githubRunId ? "github-actions" : "local",
    repository: options.repository,
    ref: options.ref,
    eventName: options.eventName,
    actor: options.actor,
  };

  const testPaths = record.plan.safety.fallbackRequired
    ? record.plan.selectedTests.slice()
    : Array.from(new Set([...record.plan.selectedTests, ...record.plan.skippedTests]));
  const pathBaseline = runPathBaseline(testPaths, record.changedFiles.map((p) => ({ path: p, changeType: "modified" })));

  record.pathBaseline = {
    testsSelected: pathBaseline.selectedTests.length,
    tasksSelected: record.actualTasks.length,
    fallbackRequired: pathBaseline.fallbackRequired,
    matchedRules: pathBaseline.matchedRules,
  };

  reliability.push(reliabilityEvent("impact-analysis", true, undefined, record.timing.totalDiffCiOverheadMs));

  let baseline = undefined;
  if (options.repository && options.token) {
    try {
      baseline = await fetchBaselineEvidence({ repository: options.repository, headSha: options.headSha, token: options.token });
      record.baseline = baseline;
      if (baseline.status === "COMPLETE") {
        record.taskTimings = buildTaskTimings(record.plan.tasks, baseline);
        record.failureRecallRecords = buildFailureRecallRecords(record.plan, baseline, record.changedFiles, identity);
        record.measured = computeMeasuredMetrics(record.plan, baseline, record.timing.totalDiffCiOverheadMs);
        reliability.push(reliabilityEvent("baseline-fetch", true));
      } else {
        const note = `Baseline evidence ${baseline.status}${baseline.completenessNotes ? `: ${baseline.completenessNotes}` : ""}`;
        reliability.push(reliabilityEvent("baseline-fetch", false, new Error(note)));
      }
    } catch (error: unknown) {
      reliability.push(reliabilityEvent("baseline-fetch", false, error));
    }
  }

  record.reliabilityEvents = reliability;
  record.explainArtifact = buildExplainArtifact(identity, record.plan, record.changedFiles, baseline, record.measured);

  return { record, identity };
}
