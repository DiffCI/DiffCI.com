import { mkdirSync, readFileSync } from "node:fs";
import { withRuntimeOptions, type Stage0RuntimeOptions } from "../config/stage0.js";
import type { ResearchRepository, RepositoryResult } from "../types.js";
import { LocalEvidenceStore } from "../store/evidence.js";
import { runRepoBenchmark } from "../benchmark/runner.js";
import { buildRepoResult, buildStage0Report } from "../benchmark/aggregator.js";
import { writeStage0Report } from "../report/stage0-report.js";
import { evaluateBudgetStatus, isSafeToStartUnderReserve, projectRemainingSpendUsd } from "../config/cost-model.js";
import { createRateBudget, DEFAULT_AUTHENTICATED_CALLS_PER_HOUR, DEFAULT_UNAUTHENTICATED_CALLS_PER_HOUR } from "../historical/rate-budget.js";

const rawCorpus = JSON.parse(readFileSync(new URL("../config/corpus.json", import.meta.url), "utf8")) as {
  version: string;
  repositories: ResearchRepository[];
};

function parseArgs(argv: string[]): Stage0RuntimeOptions {
  const options: Stage0RuntimeOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--repos" || arg === "-r") options.repositoryLimit = Math.max(1, Number.parseInt(argv[++i] ?? "0", 10));
    if (arg === "--commits" || arg === "-c") options.commitsPerRepository = Math.max(1, Number.parseInt(argv[++i] ?? "0", 10));
    if (arg === "--budget") options.budgetUsd = Number.parseFloat(argv[++i] ?? "0");
    if (arg === "--dry-run" || arg === "--dry") options.dryRun = true;
    if (arg === "--collect-historical-evidence") options.collectHistoricalEvidence = true;
    if (arg === "--github-token") options.githubToken = argv[++i];
  }
  return options;
}

async function main() {
  const runtimeOptions = parseArgs(process.argv.slice(2));
  const config = withRuntimeOptions(runtimeOptions);

  mkdirSync(config.outputDir, { recursive: true });
  const store = new LocalEvidenceStore(config.outputDir);
  const repositories = rawCorpus.repositories.slice(0, config.targetRepositories);

  // Shared across every repository/delta in this run - see the field comment on
  // Stage0ConfigSnapshot.historicalRateBudget for why this must not be per-repository.
  const historicalRateBudget = config.collectHistoricalEvidence
    ? createRateBudget(config.githubToken ? DEFAULT_AUTHENTICATED_CALLS_PER_HOUR : DEFAULT_UNAUTHENTICATED_CALLS_PER_HOUR)
    : undefined;
  if (config.collectHistoricalEvidence) {
    console.error(
      `Historical CI evidence collection: ON (${config.githubToken ? "authenticated" : "UNAUTHENTICATED - paced at " + DEFAULT_UNAUTHENTICATED_CALLS_PER_HOUR + " GitHub REST calls/hour; most deltas will show UNAVAILABLE"} )`,
    );
  } else {
    console.error("Historical CI evidence collection: OFF (pass --collect-historical-evidence to enable; failure-recall fields will read NOT MEASURABLE)");
  }
  const configWithBudget = { ...config, historicalRateBudget };

  const repoResults: RepositoryResult[] = [];
  let totalDeltas = 0;
  let budgetGuardTriggered = false;
  // This CLI path runs entirely locally (LocalEvidenceStore, no Worker/Workflow/D1/R2/Queue calls) -
  // there is no real Cloudflare spend to measure or estimate here, so both stay honestly at $0 rather
  // than fabricated. The budget-guard tier logic below (evaluateBudgetStatus) still runs for real on
  // whatever these values are, so it's exercised the same way it will be once the Cloudflare-hosted
  // path (see docs/research/2026-08-20-stage0-full-experiment-architecture.md) starts feeding real
  // measured/estimated spend into these same two accumulators.
  let measuredSpendUsd = 0;
  let estimatedSpendUsd = 0;
  let budgetStopped = false;

  const manifest = {
    experimentId: config.experimentId,
    diffciVersion: config.diffciVersion,
    schemaVersion: config.schemaVersion,
    repositorySelectionVersion: rawCorpus.version,
    commitSamplingVersion: "latest-non-merge",
    targetRepositories: config.targetRepositories,
    targetCommitDeltas: config.targetCommitDeltas,
    budgetUsd: config.budgetUsd,
    createdAt: new Date().toISOString(),
    repositories: repositories.map((r) => `${r.owner}/${r.name}`),
  };
  await store.put("manifest.json", manifest);

  for (let i = 0; i < repositories.length; i++) {
    const repo = repositories[i]!;

    if (budgetStopped) {
      console.error(`BUDGET_STOPPED: skipping remaining repositories (evidence collected so far remains usable).`);
      break;
    }

    // Reserve-mode gate: once spend crosses the reserve threshold, don't start a NEW repository
    // unless its conservatively projected cost still fits inside the remaining budget. Already-running
    // work (nothing left mid-flight in this synchronous CLI loop) is allowed to finish either way.
    const preCheck = evaluateBudgetStatus(measuredSpendUsd + estimatedSpendUsd);
    if (preCheck.reserveMode && i > 0) {
      const projected = projectRemainingSpendUsd(measuredSpendUsd + estimatedSpendUsd, i, 1);
      if (!isSafeToStartUnderReserve(measuredSpendUsd + estimatedSpendUsd, projected)) {
        budgetStopped = true;
        console.error(`BUDGET_STOPPED: reserve mode active (${preCheck.spentCredits.toFixed(2)} credits spent); projected cost of the next repository is not safely inside the remaining ${preCheck.remainingCredits.toFixed(2)} credits.`);
        break;
      }
      console.error(`  (reserve mode: ${preCheck.remainingCredits.toFixed(2)} credits remaining, next repository projected safe to start)`);
    }

    console.error(`[${i + 1}/${repositories.length}] ${repo.owner}/${repo.name} ${repo.primaryLanguage} ${repo.sizeClass}`);
    try {
      const bench = await runRepoBenchmark({ repo, store, config: configWithBudget, dryRun: config.dryRun });
      const repoResult = buildRepoResult(bench);
      repoResults.push(repoResult);
      totalDeltas += repoResult.commitsAnalyzed;
      // See the comment above measuredSpendUsd's declaration: this CLI path is local-only, so both
      // accumulators stay at 0 rather than being multiplied by a fabricated per-delta cost.

      console.error(`  -> ${repoResult.commitsAnalyzed} deltas (${bench.resumedFromExisting} resumed from prior evidence), fallback ${(repoResult.fallbackRate * 100).toFixed(1)}%, reduction ${(repoResult.medianTaskReduction * 100).toFixed(1)}%`);
      if (bench.errors.length > 0) {
        for (const e of bench.errors.slice(0, 5)) console.error(`  ERR: ${e}`);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  FATAL: ${message}`);
      repoResults.push({
        metadata: { repository: `${repo.owner}/${repo.name}`, primaryLanguage: repo.primaryLanguage, framework: repo.framework, sizeClass: repo.sizeClass, cloneUrl: `https://github.com/${repo.owner}/${repo.name}.git`, localPath: "", license: "unknown", defaultBranch: "main", commitCount: 0, sourceFiles: 0, workflowFiles: 0, languageSupport: { diffciGraphCapable: false, reason: "not evaluated" }, exclusionReason: `runner fatal error: ${message}` },
        commitsAnalyzed: 0,
        fallbackRate: 0,
        medianTaskReduction: 0,
        pathBaselineMedianReduction: 0,
        diffciIncrementalAdvantage: 0,
        failureEvents: 0,
        unsafeMisses: 0,
        records: [],
      });
    }

    const postCheck = evaluateBudgetStatus(measuredSpendUsd + estimatedSpendUsd);
    budgetGuardTriggered = postCheck.reserveMode;
    if (postCheck.mustStop) {
      budgetStopped = true;
      console.error(`BUDGET_STOPPED: spend reached ${postCheck.spentCredits.toFixed(2)} credits (hard stop at ${1950}); stopping new scheduling. This is not a failure - all evidence collected so far remains usable.`);
      break;
    }
    if (postCheck.status === "WARNING") {
      console.error(`BUDGET_WARNING: ${postCheck.spentCredits.toFixed(2)} of 2000 credits spent; reassessing projected remaining cost.`);
    }

    if (!config.dryRun && totalDeltas >= config.targetCommitDeltas) {
      console.error(`Target commit deltas (${config.targetCommitDeltas}) reached; stopping.`);
      break;
    }
  }

  const finalBudget = evaluateBudgetStatus(measuredSpendUsd + estimatedSpendUsd);
  await store.put("failures/budget-guard.json", {
    status: finalBudget.status,
    triggered: budgetGuardTriggered,
    measuredSpendUsd,
    estimatedSpendUsd,
    spentCredits: finalBudget.spentCredits,
    remainingCredits: finalBudget.remainingCredits,
    budgetUsd: config.budgetUsd,
  });

  const report = buildStage0Report(repoResults, {
    experimentId: config.experimentId,
    diffciVersion: config.diffciVersion,
    schemaVersion: config.schemaVersion,
    measuredSpendUsd,
    estimatedSpendUsd,
    projectedRemainingSpendUsd: totalDeltas > 0 ? projectRemainingSpendUsd(measuredSpendUsd + estimatedSpendUsd, totalDeltas, Math.max(0, config.targetCommitDeltas - totalDeltas)) : undefined,
    budgetStatus: finalBudget.status,
    budgetGuardTriggered,
  });
  writeStage0Report(report, config.outputDir);
  await store.put("reports/summary.json", report.summary);
  console.log(JSON.stringify(report.summary, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
