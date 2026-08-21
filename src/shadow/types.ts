import type { ExecutionPlan } from "../planner/types.js";

export interface CommitRange {
  baseSha: string;
  headSha: string;
}

export interface TimingBreakdown {
  gitAnalysisMs: number;
  graphConstructionMs: number;
  graphConstructionColdMs?: number;
  graphLoadWarmMs?: number;
  cacheInvalidationMs?: number;
  impactAnalysisMs: number;
  plannerMs: number;
  totalDiffCiOverheadMs: number;
}

export interface GraphCacheMetrics {
  coldGraphBuildMs?: number;
  warmGraphLoadMs?: number;
  serializedGraphSizeBytes?: number;
  heapDuringGraphBuildMb?: number;
  heapAfterGraphExtractionMb?: number;
  cacheHit: boolean;
  cacheKey: string;
}

export interface CostAssumptions {
  runnerCostPerMinute?: number;
  currency?: string;
}

export interface SustainabilityAssumptions {
  runnerPowerWatts?: number;
  gridCarbonIntensityGramsPerKwh?: number;
}

export interface ShadowRunRecord {
  schemaVersion: string;
  recordedAt: string;
  runIdentity?: ShadowRunIdentity;
  ciEnvironment?: {
    provider: "github-actions" | "local";
    repository?: string;
    ref?: string;
    eventName?: string;
    actor?: string;
  };
  commit: CommitRange;
  changedFiles: string[];
  impactFallback: boolean;
  fallbackReasons: string[];
  plan: ExecutionPlan;
  actualTasks: string[];
  proposedTasks: string[];
  actualTestCount: number;
  selectedTestCount: number;
  timing: TimingBreakdown;
  cacheMetrics?: GraphCacheMetrics;
  baseline?: BaselineEvidence;
  taskTimings?: TaskTiming[];
  failureRecallRecords?: FailureRecallRecord[];
  explainArtifact?: string;
  reliabilityEvents?: ReliabilityEvent[];
  measured?: ShadowMeasuredMetrics;
  pathBaseline?: { testsSelected: number; tasksSelected: number; fallbackRequired: boolean; matchedRules: string[] };
}

export interface BenchmarkRun {
  schemaVersion: string;
  recordedAt: string;
  diffciVersion: string;
  commit: CommitRange;
  commitCategory: CommitCategory;
  changedFiles: string[];
  plan: ExecutionPlan;
  baseline: {
    testsTotal: number;
    tasksTotal: number;
  };
  proposed: {
    testsSelected: number;
    tasksSelected: number;
    alwaysRunTasks: number;
    fallbackRequired: boolean;
  };
  pathBaseline: {
    testsSelected: number;
    fallbackRequired: boolean;
    matchedRules: string[];
  };
  metrics: {
    testReductionPercent: number;
    taskReductionPercent: number;
    pathBaselineReductionPercent: number;
    diffCiAdvantageOverPathPercent: number;
  };
  timing?: TimingBreakdown;
  measured?: {
    baselineSeconds?: number;
    proposedSeconds?: number;
  };
  estimated?: {
    computeMinutesAvoided?: number;
    costAvoided?: number;
    energyKwhSaved?: number;
    co2KgSaved?: number;
  };
  assumptions?: {
    cost?: CostAssumptions;
    sustainability?: SustainabilityAssumptions;
  };
}

export interface ShadowRunIdentity {
  repository: string;
  baseSha: string;
  headSha: string;
  githubRunId?: string;
  githubRunAttempt?: number;
  workflow?: string;
  eventName?: string;
  ref?: string;
  diffciVersion: string;
  schemaVersion: string;
  /** deterministic analysis key */
  logicalKey: string;
  /** one concrete execution */
  executionKey: string;
}

export interface TaskTiming {
  taskId: string;
  jobName?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  status: "passed" | "failed" | "skipped-by-existing-ci" | "unknown";
}

export interface BaselineRunInfo {
  workflowPath: string;
  workflowRunId: number;
  runNumber: number;
  status: string;
  conclusion: string | null;
  htmlUrl: string;
}

export interface BaselineStepInfo {
  name: string;
  status: string;
  conclusion?: string;
  durationMs?: number;
}

export interface BaselineJobInfo {
  jobId: number;
  jobName: string;
  status: string;
  conclusion?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  steps?: BaselineStepInfo[];
}

/** Task 2 (2026-08-21 reconciliation observability): a closed vocabulary for WHY a prediction has no
 * completed ground truth yet, distinct from completenessNotes' free text - lets an operator-facing
 * diagnostic group pending predictions meaningfully (GET /v1/shadow/reconcile-diagnostics) instead of
 * every case reading as an opaque "no matching historical CI run found". Only set when status is
 * UNAVAILABLE and no fetch/rate-limit error occurred first (those keep using fetchError/"github_rate_limit"
 * - this vocabulary is specifically about "we successfully asked GitHub, and here's what we learned"). */
export type ReconcilePendingReason =
  | "no_matching_workflow" // no run (queued, in-flight, or completed) exists yet for this SHA at all
  | "ci_queued" // a run exists but has not started
  | "ci_in_progress"; // a run exists and is currently running

export interface BaselineEvidence {
  repository: string;
  headSha: string;
  status: "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
  completenessNotes?: string;
  /** Only meaningful when status is UNAVAILABLE with no fetchError - see ReconcilePendingReason. */
  pendingReason?: ReconcilePendingReason;
  fullRunsObserved: BaselineRunInfo[];
  jobs: BaselineJobInfo[];
  failedJobNames: string[];
  baselineDurationMs?: number;
  failedTaskIds: string[];
  fetchError?: string;
  /** Total real GitHub REST calls this fetch made (runs list + per-run jobs + the optional pending-
   * reason classification call) - the rate-budget caller (evidence-collector.ts) charges exactly this,
   * not a recomputed estimate, so the pending-reason classification call is never charged for free. */
  apiCallsMade: number;
}

export interface FailureRecallRecord {
  runIdentity?: ShadowRunIdentity;
  failureType: "task" | "test";
  target: string;
  selectedByDiffCI: boolean;
  diffCIMode: "FULL" | "SELECTIVE";
  relatedChangedFiles: string[];
  impactEvidence?: unknown;
  planTaskStatus?: string;
}

export interface ShadowMeasuredMetrics {
  baselineDurationMs?: number;
  retainedTaskDurationMs?: number;
  skipCandidateDurationMs?: number;
  netPotentialTimeSavedMs?: number;
  netPotentialReductionPercent?: number;
}

export interface ReliabilityEvent {
  stage: string;
  success: boolean;
  errorMessage?: string;
  durationMs?: number;
}

export interface ShadowAggregate {
  rawExecutions: number;
  uniqueCommitDeltas: number;
  workflowRetries: number;
  duplicateAnalyses: number;
  malformedRecords: number;
  completeRecords: number;
  incompleteRecords: number;
  fullModeCount: number;
  selectiveModeCount: number;
  pathBaselineFullCount: number;
  diffCiFullCount: number;
  medianPotentialTaskReductionPercent: number;
  medianMeasuredPotentialRuntimeReductionMs?: number;
  medianDiffCiOverheadMs: number;
  cacheHitCount: number;
  cacheMissCount: number;
  failedTasksObserved: number;
  failedTestsObserved: number;
  unsafeTaskMisses: number;
  unsafeTestMisses: number;
  taskRecallPercent?: number;
  testRecallPercent?: number;
}

export interface ShadowReport {
  schemaVersion: string;
  generatedAt: string;
  diffciVersion: string;
  repository?: string;
  aggregate: ShadowAggregate;
  uniqueDeltas: {
    logicalKey: string;
    identity: ShadowRunIdentity;
    mode: "FULL" | "SELECTIVE";
    taskReductionPercent: number;
    measured?: ShadowMeasuredMetrics;
    failureRecallRecords: FailureRecallRecord[];
  }[];
  rawExecutions: ShadowRunRecord[];
  failureRecallRecords: FailureRecallRecord[];
  reliabilityEvents: ReliabilityEvent[];
}

export type CommitCategory =
  | "docs-only"
  | "isolated-frontend"
  | "shared-frontend"
  | "api-backend"
  | "shared-library"
  | "test-only"
  | "scripts"
  | "infrastructure"
  | "database"
  | "config-dependency"
  | "mixed"
  | "unknown";

export interface BenchmarkStats {
  totalCommits: number;
  selectiveCommits: number;
  fallbackCommits: number;
  selectivePercentage: number;
  fallbackPercentage: number;
  meanSelectedTestPercent: number;
  medianSelectedTestPercent: number;
  p25SelectedTestPercent: number;
  p75SelectedTestPercent: number;
  p90SelectedTestPercent: number;
  meanPotentialTestReduction: number;
  medianPotentialTestReduction: number;
  meanPathBaselineReduction: number;
  meanDiffCiAdvantage: number;
}

export interface CategoryStats {
  category: CommitCategory;
  commits: number;
  fallbackRate: number;
  meanSelectedTestPercent: number;
  medianSelectedTestPercent: number;
}

export interface BenchmarkReport {
  schemaVersion: string;
  generatedAt: string;
  selectionMethod: string;
  sampleSize: number;
  aggregate: BenchmarkStats;
  aggregateSelectiveOnly?: BenchmarkStats;
  categories: CategoryStats[];
  runs: BenchmarkRun[];
}
