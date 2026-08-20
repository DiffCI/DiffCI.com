import type { ExecutionPlan } from "../planner/types.js";
import type { GitDelta } from "../git/types.js";
import type { DependencyGraphResult, RepositoryProfile } from "../repo/types.js";
import type { BudgetStatus } from "./config/cost-model.js";

export type { BudgetStatus } from "./config/cost-model.js";

/** Classification of whether historical CI evidence could be obtained for a delta, per the Stage 0
 * spec's requirement to never claim precision the evidence doesn't support. MEASURABLE: a complete,
 * non-shadow CI run was found and fully parsed. PARTIALLY_MEASURABLE: a run was found but some jobs
 * could not be fetched/parsed. UNAVAILABLE: no usable evidence (no matching run, or the GitHub rate
 * budget was exhausted before this delta could be checked - see historicalEvidenceReason). */
export type HistoricalEvidenceStatus = "MEASURABLE" | "PARTIALLY_MEASURABLE" | "UNAVAILABLE";

export interface ResearchRepository {
  owner: string;
  name: string;
  primaryLanguage: string;
  framework: string;
  sizeClass: "small" | "medium" | "large" | "very-large";
}

export interface ResearchCorpus {
  version: string;
  selectionCriteria: string[];
  repositories: ResearchRepository[];
}

export interface RepositoryMetadata {
  repository: string;
  cloneUrl: string;
  localPath: string;
  primaryLanguage: string;
  framework: string;
  sizeClass: string;
  license: string;
  defaultBranch: string;
  commitCount: number;
  sourceFiles: number;
  workflowFiles: number;
  languageSupport: {
    diffciGraphCapable: boolean;
    reason: string;
  };
  exclusionReason?: string;
}

export type CommitCategory =
  | "documentation"
  | "frontend-isolated"
  | "frontend-shared"
  | "backend-isolated"
  | "backend-shared"
  | "api"
  | "shared-library"
  | "test-only"
  | "configuration"
  | "dependency"
  | "infrastructure"
  | "database"
  | "assets"
  | "mixed"
  | "deletion"
  | "rename"
  | "unknown";

export interface CommitDelta {
  repository: string;
  baseSha: string;
  headSha: string;
  logicalDeltaKey: string;
  experimentId: string;
  diffCiVersion: string;
  schemaVersion: string;
  category: CommitCategory;
  gitDelta: GitDelta;
}

export interface DiffCIAnalysisResult {
  identity: CommitDelta;
  profile: RepositoryProfile;
  graphResult: DependencyGraphResult;
  plan: ExecutionPlan;
  timing: {
    gitAnalysisMs: number;
    graphConstructionMs: number;
    graphLoadWarmMs?: number;
    cacheInvalidationMs?: number;
    impactAnalysisMs: number;
    plannerMs: number;
    totalDiffCiOverheadMs: number;
    coldCache: boolean;
  };
  cacheMetrics: {
    cacheHit: boolean;
    serializedGraphSizeBytes?: number;
    heapDuringGraphBuildMb?: number;
  };
  fallbackReasons: string[];
  classification: {
    graphConfidence: DependencyGraphResult["confidence"];
    languageSupported: boolean;
    fallbackRequired: boolean;
  };
}

export interface BenchmarkRecord {
  identity: CommitDelta;
  repository: string;
  language: string;
  framework: string;
  sizeClass: string;
  category: CommitCategory;
  fallback: boolean;
  fallbackReasons: string[];
  fullTasks: number;
  diffciTasks: number;
  pathBaselineTasks: number;
  alwaysRunTasks: number;
  taskReduction: {
    fullVsDiffci: number;
    fullVsPath: number;
    pathVsDiffci: number;
  };
  /** Total individual test files known for the repository (real file count, not glob-pattern
   * count - see RepositoryProfile.testFilePaths). */
  testsTotal: number;
  /** How many individual tests the (production) per-test PATH baseline would run for this delta. */
  testsSelectedByPath: number;
  /** How many individual tests DiffCI's real graph-driven impact analysis selected for this
   * delta (equals testsTotal when the delta triggers FULL fallback). */
  testsSelectedByDiffci: number;
  timingMs: DiffCIAnalysisResult["timing"];
  cacheHit: boolean;
  graphConfidence: DependencyGraphResult["confidence"];
  changedFileCount: number;
  failureStatus?: "NO_DATA" | "NO_FAILURE" | "RETAINED" | "OMITTED";
  /** Historical CI evidence status for this specific delta - see HistoricalEvidenceStatus. Absent
   * entirely (not just UNAVAILABLE) means evidence collection was never attempted for this delta
   * (e.g. it was outside the per-run GitHub rate budget's sample). */
  historicalEvidenceStatus?: HistoricalEvidenceStatus;
  historicalEvidenceReason?: string;
  /** Task/test identifiers that actually failed in the matched historical CI run, when evidence was
   * obtained. Used for failure-recall computation; empty (not absent) means evidence was obtained and
   * nothing failed. */
  historicalFailedTargets?: string[];
  /** Subset of historicalFailedTargets that DiffCI's plan did NOT select for this delta - i.e. unsafe
   * misses. Computed at collection time (where the full ExecutionPlan is available) via
   * src/shadow/failure-recall.ts, not reconstructed later from aggregate counts. Empty (not absent)
   * means evidence was obtained and every historical failure was safely retained. */
  historicalUnsafeMissTargets?: string[];
  /** Same as historicalUnsafeMissTargets but for the PATH baseline's selection, for the "does DiffCI
   * beat a competent PATH baseline on safety too" comparison. */
  historicalPathUnsafeMissTargets?: string[];
  /** Stage 1B (2026-08-21): matched failed task ids that were excluded from both
   * historicalUnsafeMissTargets and historicalPathUnsafeMissTargets because they matched a non-test-
   * category task (e.g. a job named "tests" whose actual failing step was lint, or a "Release" job
   * with no relationship to test selection) - see filterToTestCategoryTaskIds() in
   * evidence-collector.ts. Kept visible for auditability, never silently dropped. */
  historicalNonTestCategoryExcludedTargets?: string[];
  /** Stage 1B (2026-08-21): matched candidate misses excluded because a cross-commit flakiness check
   * (flakiness-check.ts) found the same job succeeds on most nearby commits - a suspicion, not a
   * certainty. Empty (not absent) whenever flakiness checking ran and found nothing suspect; absent
   * entirely means flakiness checking was not enabled for this run. */
  historicalLikelyFlakyExcludedTargets?: string[];
  /** Set (never absent-vs-false silently) when 0 <= testsSelectedByDiffci <= testsTotal or
   * 0 <= testsSelectedByPath <= testsTotal is violated - an impossible count. Root-caused in Stage 1A
   * (2026-08-21, docs/research/2026-08-21-stage1a-valtio-anomaly.md): the benchmark harness never
   * checks the repository out to a delta's specific headSha before running graph/test-discovery, so a
   * file added at a historical commit and later renamed/moved is invisible to the (tip-state) test-file
   * scan while still correctly reported as "added" by the (headSha-independent) git-diff computation.
   * Deliberately NOT clamped - the underlying values are left exactly as computed so the anomaly stays
   * visible; aggregation should exclude flagged records rather than silently including impossible data. */
  testCountInvariantViolation?: { reason: string };
}

export interface RepositoryResult {
  metadata: RepositoryMetadata;
  commitsAnalyzed: number;
  fallbackRate: number;
  medianTaskReduction: number;
  medianRuntimeOpportunity?: number;
  pathBaselineMedianReduction: number;
  diffciIncrementalAdvantage: number;
  failureEvents: number;
  unsafeMisses: number;
  records: BenchmarkRecord[];
}

export interface Stage0Summary {
  experimentId: string;
  generatedAt: string;
  diffciVersion: string;
  schemaVersion: string;
  repositoriesSelected: number;
  repositoriesAnalyzed: number;
  repositoriesExcluded: number;
  uniqueCommitDeltas: number;
  duplicateAnalyses: number;
  /** Deltas excluded from every test-count-derived metric below due to an impossible count
   * (testCountInvariantViolation set) - never silently included, never clamped. */
  testCountInvalidDeltas: number;
  fullCommits: number;
  selectiveCommits: number;
  fallbackRate: number;
  medianTaskReduction: number;
  taskReductionP25: number;
  taskReductionP75: number;
  taskReductionP90: number;
  pathBaselineReduction: number;
  pathBaselineReductionP25: number;
  pathBaselineReductionP75: number;
  pathBaselineReductionP90: number;
  diffciIncrementalAdvantage: number;
  diffciIncrementalAdvantageP25: number;
  diffciIncrementalAdvantageP75: number;
  diffciIncrementalAdvantageP90: number;
  /** Individual-test-level equivalents of the task-reduction fields above. Do not infer
   * runtime from these - test-count reduction is a weaker signal than task-level reduction. */
  testsTotalAcrossDeltas: number;
  testsSelectedByPathAcrossDeltas: number;
  testsSelectedByDiffciAcrossDeltas: number;
  medianTestReductionByPath: number;
  medianTestReductionByDiffci: number;
  diffciIncrementalTestAdvantage: number;
  medianNetRuntimeOpportunityMs?: number;
  medianRuntimeOpportunity?: number;
  timingCompleteDeltas: number;
  fullMedianMeasuredRuntimeMs?: number;
  pathRetainedRuntimeMs?: number;
  diffciRetainedRuntimeMs?: number;
  diffciOverheadMedianMs: number;
  cacheHitRate: number;
  coldAnalysisP50Ms: number;
  coldAnalysisP90Ms: number;
  warmAnalysisP50Ms: number;
  warmAnalysisP90Ms: number;
  historicalFailures: number;
  historicalFailingDeltas: number;
  unsafeMisses: number;
  pathUnsafeMisses: number;
  observedDiffciFailureRecall?: "NOT MEASURABLE" | number;
  observedPathFailureRecall?: "NOT MEASURABLE" | number;
  /** measuredSpendUsd + estimatedSpendUsd. Kept for backward compatibility with existing report
   * rendering; new code should read the two components separately (see cost-model.ts) rather than
   * treating this combined figure as fully "measured". */
  cloudflareSpendUsd: number;
  /** Exact operation counts x published Cloudflare rates - see computeMeasuredUsd() in cost-model.ts. */
  measuredSpendUsd: number;
  /** CPU-ms approximated from wall-clock timing (no in-Worker CPU-ms readback API exists) x the
   * published CPU-ms rate. Always a conservative over-estimate, never merged silently into
   * measuredSpendUsd. */
  estimatedSpendUsd: number;
  /** Conservative projection of total spend if the remaining planned deltas cost the same on average
   * as the deltas completed so far, plus a safety margin - see projectRemainingSpendUsd() /
   * isSafeToStartUnderReserve() in cost-model.ts. Undefined until at least one delta has completed. */
  projectedRemainingSpendUsd?: number;
  budgetStatus: BudgetStatus;
  costPerRepositoryUsd?: number;
  costPer1000CommitsUsd?: number;
  topTechnicalProblems: string[];
  topFallbackReasons: string[];
  budgetGuardTriggered: boolean;
  proceedToStage1: "STOP" | "PROCEED WITH CHANGES" | "PROCEED";
  /** Answers to the required Stage 0 final questions. */
  verdict: Stage0Verdict;
}

export interface Stage0Verdict {
  materialOutperformance: "NO MATERIAL ADVANTAGE" | "MODEST ADVANTAGE" | "MATERIAL ADVANTAGE" | "LARGE ADVANTAGE";
  medianNetRuntimeOpportunityMs?: number;
  fallbackRate: number;
  topFallbackReasons: string[];
  repositoryMostBenefit: string;
  repositoryLeastBenefit: string;
  diffciUnsafeMisses: number;
  pathUnsafeMisses: number;
  generalizesOutsideDentalPresence: boolean;
  cloudflareCostJustifiesStage1: boolean;
  proceedTo100Repositories: "STOP" | "PROCEED WITH CHANGES" | "PROCEED";
  explanation: string;
}

export interface Stage0Report {
  summary: Stage0Summary;
  repositoryResults: RepositoryResult[];
  excludedRepositories: RepositoryMetadata[];
}

export type FailureRecallResult = {
  failureType: "task" | "test";
  target: string;
  selectedByDiffCI: boolean;
  diffCIMode: "FULL" | "SELECTIVE";
  relatedChangedFiles: string[];
};

export interface EvidenceStore {
  put(key: string, value: unknown): Promise<void>;
  get(key: string): Promise<unknown | undefined>;
  exists(key: string): Promise<boolean>;
  list(prefix: string): Promise<string[]>;
}
