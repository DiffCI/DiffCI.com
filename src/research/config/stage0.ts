import { resolve } from "node:path";

export const DIFFCI_VERSION = "0.6.0-phase6";
export const SCHEMA_VERSION = "diffci-research/stage0-2";
export const EXPERIMENT_ID = `stage0-${new Date().toISOString().slice(0, 10)}`;

export interface Stage0RuntimeOptions {
  /** Limit how many repositories from the corpus to analyze. */
  repositoryLimit?: number;
  /** Limit how many eligible commit deltas to analyze per repository. */
  commitsPerRepository?: number;
  /** Maximum recent commits to consider when sampling. */
  recentCommitWindow?: number;
  /** Maximum USD spend allowed before stopping new repository scheduling. */
  budgetUsd?: number;
  /** Dry-run mode: prepare manifest and repo metadata but skip deep analysis. */
  dryRun?: boolean;
  /** Opt-in: attempt historical CI evidence collection (see src/research/historical/). Off by default
   * - see collectHistoricalEvidence on Stage0ConfigSnapshot for why. */
  collectHistoricalEvidence?: boolean;
  /** GitHub token for historical evidence collection; falls back to GITHUB_TOKEN env var. Raises the
   * unauthenticated 60/hour REST cap to 5,000/hour when present. */
  githubToken?: string;
}

export const STAGE0_CONFIG = {
  experimentId: EXPERIMENT_ID,
  diffciVersion: DIFFCI_VERSION,
  schemaVersion: SCHEMA_VERSION,
  targetRepositories: 20,
  targetCommitDeltas: 2000,
  maxCommitsPerRepository: 100,
  recentCommitWindow: 200,
  excludeMergeCommits: true,
  excludeBotCommits: true,
  minParentCommits: 1,
  cloneDepth: 300,
  maxRepoDiskMb: 1024,
  maxRepoSourceFiles: 5000,
  maxRepoSizeClass: "large" as const,
  graphTimeouts: {
    smallMs: 30_000,
    mediumMs: 120_000,
    largeMs: 300_000,
  },
  cacheDir: resolve(import.meta.dirname, "../../../.research/cache/graphs"),
  repoCacheDir: resolve(import.meta.dirname, "../../../.research/cache/repos"),
  outputDir: resolve(import.meta.dirname, "../../../.research/output/stage0"),
  fallbackToLocal: true,
  workerConcurrency: 1,
  budgetUsd: 200,
  costModel: {
    workerRequestUsd: 0.0000005,
    queueOperationUsd: 0.0000004,
    r2ReadUsd: 0.000001,
    r2WriteUsd: 0.00005,
    r2StoreUsdPerGbMonth: 0.015,
    heavyComputeUsdPerHour: 0.6,
    heavyComputeRuntimeAssumptionHours: 0,
  },
};

export function withRuntimeOptions(options: Stage0RuntimeOptions) {
  const maxCommits = options.commitsPerRepository ?? STAGE0_CONFIG.maxCommitsPerRepository;
  return {
    ...STAGE0_CONFIG,
    targetRepositories: options.repositoryLimit ?? STAGE0_CONFIG.targetRepositories,
    maxCommitsPerRepository: maxCommits,
    recentCommitWindow: options.recentCommitWindow ?? Math.max(maxCommits * 2, STAGE0_CONFIG.recentCommitWindow),
    budgetUsd: options.budgetUsd ?? STAGE0_CONFIG.budgetUsd,
    dryRun: options.dryRun ?? false,
    collectHistoricalEvidence: options.collectHistoricalEvidence ?? false,
    githubToken: options.githubToken ?? process.env.GITHUB_TOKEN,
  };
}
