import type { BenchmarkRecord, BudgetStatus, RepositoryResult, Stage0Report, Stage0Summary, Stage0Verdict } from "../types.js";

export interface BuildReportOptions {
  experimentId: string;
  diffciVersion: string;
  schemaVersion: string;
  measuredSpendUsd?: number;
  estimatedSpendUsd?: number;
  projectedRemainingSpendUsd?: number;
  budgetStatus?: BudgetStatus;
  budgetGuardTriggered?: boolean;
}

/** Removes duplicate logical-delta records (same logicalDeltaKey), keeping the first occurrence, so a
 * rerun/retry can never contaminate aggregation - "No duplicate deltas should contaminate aggregation"
 * per the Stage 0 spec. Returns the deduped records plus how many duplicates were dropped. */
function dedupeByLogicalDeltaKey(records: BenchmarkRecord[]): { deduped: BenchmarkRecord[]; duplicateCount: number } {
  const seen = new Set<string>();
  const deduped: BenchmarkRecord[] = [];
  let duplicateCount = 0;
  for (const record of records) {
    const key = record.identity.logicalDeltaKey;
    if (seen.has(key)) {
      duplicateCount++;
      continue;
    }
    seen.add(key);
    deduped.push(record);
  }
  return { deduped, duplicateCount };
}

export function buildStage0Report(repoResults: RepositoryResult[], options: BuildReportOptions): Stage0Report {
  const {
    experimentId,
    diffciVersion,
    schemaVersion,
    measuredSpendUsd = 0,
    estimatedSpendUsd = 0,
    projectedRemainingSpendUsd,
    budgetStatus = "OK",
    budgetGuardTriggered = false,
  } = options;
  const analyzed = repoResults.filter((r) => r.commitsAnalyzed > 0 && !r.metadata.exclusionReason);
  const excluded = repoResults.filter((r) => r.metadata.exclusionReason || r.commitsAnalyzed === 0);
  const { deduped: allRecords, duplicateCount: duplicateAnalyses } = dedupeByLogicalDeltaKey(analyzed.flatMap((r) => r.records));
  const fullRecords = allRecords.filter((r) => r.fallback || r.diffciTasks === r.fullTasks);
  const selectiveRecords = allRecords.filter((r) => !r.fallback && r.diffciTasks < r.fullTasks);
  const fallbackRecords = allRecords.filter((r) => r.fallback);

  const reductions = allRecords.map((r) => r.taskReduction.fullVsDiffci);
  const pathReductions = allRecords.map((r) => r.taskReduction.fullVsPath);
  const incremental = allRecords.map((r) => Math.max(0, r.taskReduction.fullVsDiffci - r.taskReduction.fullVsPath));
  const overheadMs = allRecords.map((r) => r.timingMs.totalDiffCiOverheadMs);

  // Records with an impossible test count (0 <= selected <= total violated - see
  // BenchmarkRecord.testCountInvariantViolation, root-caused in Stage 1A 2026-08-21) are excluded from
  // every test-count-derived metric below, same precedent as sindresorhus/ky's known-bad test counts.
  // Task-level metrics (reductions/pathReductions/incremental above) are unaffected by this specific
  // bug and correctly continue to use the full deduped set.
  const testCountInvalidRecords = allRecords.filter((r) => r.testCountInvariantViolation);
  const testLevelValidRecords = allRecords.filter((r) => !r.testCountInvariantViolation);

  const testsTotalAcrossDeltas = testLevelValidRecords.reduce((sum, r) => sum + r.testsTotal, 0);
  const testsSelectedByPathAcrossDeltas = testLevelValidRecords.reduce((sum, r) => sum + r.testsSelectedByPath, 0);
  const testsSelectedByDiffciAcrossDeltas = testLevelValidRecords.reduce((sum, r) => sum + r.testsSelectedByDiffci, 0);
  const testReductionsByPath = testLevelValidRecords.filter((r) => r.testsTotal > 0).map((r) => (r.testsTotal - r.testsSelectedByPath) / r.testsTotal);
  const testReductionsByDiffci = testLevelValidRecords.filter((r) => r.testsTotal > 0).map((r) => (r.testsTotal - r.testsSelectedByDiffci) / r.testsTotal);
  const incrementalTest = testLevelValidRecords
    .filter((r) => r.testsTotal > 0)
    .map((r) => Math.max(0, (r.testsTotal - r.testsSelectedByDiffci) / r.testsTotal - (r.testsTotal - r.testsSelectedByPath) / r.testsTotal));
  const coldMs = allRecords.filter((r) => !r.cacheHit).map((r) => r.timingMs.totalDiffCiOverheadMs);
  const warmMs = allRecords.filter((r) => r.cacheHit).map((r) => r.timingMs.totalDiffCiOverheadMs);

  // Historical CI evidence / failure recall - computed only from records that actually got evidence
  // (MEASURABLE or PARTIALLY_MEASURABLE); never inferred from records where evidence was never
  // attempted or came back UNAVAILABLE. Numerator/denominator both reported per the Stage 0 spec.
  const evidencedRecords = allRecords.filter(
    (r) => r.historicalEvidenceStatus === "MEASURABLE" || r.historicalEvidenceStatus === "PARTIALLY_MEASURABLE",
  );
  const historicalFailingDeltas = evidencedRecords.filter((r) => (r.historicalFailedTargets?.length ?? 0) > 0).length;
  const historicalFailures = evidencedRecords.reduce((sum, r) => sum + (r.historicalFailedTargets?.length ?? 0), 0);
  const diffciUnsafeMisses = evidencedRecords.reduce((sum, r) => sum + (r.historicalUnsafeMissTargets?.length ?? 0), 0);
  const pathUnsafeMisses = evidencedRecords.reduce((sum, r) => sum + (r.historicalPathUnsafeMissTargets?.length ?? 0), 0);
  const observedDiffciFailureRecall: "NOT MEASURABLE" | number =
    historicalFailures > 0 ? ((historicalFailures - diffciUnsafeMisses) / historicalFailures) * 100 : "NOT MEASURABLE";
  const observedPathFailureRecall: "NOT MEASURABLE" | number =
    historicalFailures > 0 ? ((historicalFailures - pathUnsafeMisses) / historicalFailures) * 100 : "NOT MEASURABLE";

  const totalSpend = measuredSpendUsd + estimatedSpendUsd;
  const costPerRepo = analyzed.length > 0 ? totalSpend / analyzed.length : undefined;
  const costPer1000 = allRecords.length > 0 ? (totalSpend / allRecords.length) * 1000 : undefined;
  const topFallbackReasons = collectFallbackReasons(allRecords);
  const topTechnicalProblems = collectProblems(repoResults);

  const summary: Stage0Summary = {
    experimentId,
    generatedAt: new Date().toISOString(),
    diffciVersion,
    schemaVersion,
    repositoriesSelected: repoResults.length,
    repositoriesAnalyzed: analyzed.length,
    repositoriesExcluded: excluded.length,
    uniqueCommitDeltas: allRecords.length,
    duplicateAnalyses,
    testCountInvalidDeltas: testCountInvalidRecords.length,
    fullCommits: fullRecords.length,
    selectiveCommits: selectiveRecords.length,
    fallbackRate: allRecords.length === 0 ? 0 : fallbackRecords.length / allRecords.length,
    medianTaskReduction: median(reductions),
    taskReductionP25: percentile(reductions, 25),
    taskReductionP75: percentile(reductions, 75),
    taskReductionP90: percentile(reductions, 90),
    pathBaselineReduction: median(pathReductions),
    pathBaselineReductionP25: percentile(pathReductions, 25),
    pathBaselineReductionP75: percentile(pathReductions, 75),
    pathBaselineReductionP90: percentile(pathReductions, 90),
    diffciIncrementalAdvantage: median(incremental),
    diffciIncrementalAdvantageP25: percentile(incremental, 25),
    diffciIncrementalAdvantageP75: percentile(incremental, 75),
    diffciIncrementalAdvantageP90: percentile(incremental, 90),
    testsTotalAcrossDeltas,
    testsSelectedByPathAcrossDeltas,
    testsSelectedByDiffciAcrossDeltas,
    medianTestReductionByPath: median(testReductionsByPath),
    medianTestReductionByDiffci: median(testReductionsByDiffci),
    diffciIncrementalTestAdvantage: median(incrementalTest),
    timingCompleteDeltas: allRecords.filter((r) => r.timingMs.totalDiffCiOverheadMs > 0).length,
    diffciOverheadMedianMs: median(overheadMs),
    cacheHitRate: allRecords.length === 0 ? 0 : allRecords.filter((r) => r.cacheHit).length / allRecords.length,
    coldAnalysisP50Ms: median(coldMs),
    coldAnalysisP90Ms: percentile(coldMs, 90),
    warmAnalysisP50Ms: median(warmMs),
    warmAnalysisP90Ms: percentile(warmMs, 90),
    historicalFailures,
    historicalFailingDeltas,
    unsafeMisses: diffciUnsafeMisses,
    pathUnsafeMisses,
    observedDiffciFailureRecall,
    observedPathFailureRecall,
    cloudflareSpendUsd: totalSpend,
    measuredSpendUsd,
    estimatedSpendUsd,
    projectedRemainingSpendUsd,
    budgetStatus,
    costPerRepositoryUsd: costPerRepo,
    costPer1000CommitsUsd: costPer1000,
    topTechnicalProblems,
    topFallbackReasons,
    budgetGuardTriggered,
    proceedToStage1: "STOP",
    verdict: buildVerdict(analyzed, reductions, incremental, testReductionsByDiffci, incrementalTest, topFallbackReasons, budgetStatus, diffciUnsafeMisses, pathUnsafeMisses),
  };

  summary.proceedToStage1 = computeProceedRecommendation(summary);
  summary.verdict.proceedTo100Repositories = summary.proceedToStage1;

  return { summary, repositoryResults: analyzed, excludedRepositories: excluded.map((r) => r.metadata) };
}

function buildVerdict(
  analyzed: RepositoryResult[],
  reductions: number[],
  incremental: number[],
  testReductionsByDiffci: number[],
  incrementalTest: number[],
  topFallbackReasons: string[],
  budgetStatus: BudgetStatus,
  diffciUnsafeMisses: number,
  pathUnsafeMisses: number,
): Stage0Verdict {
  const medianReduction = median(reductions);
  const medianIncremental = median(incremental);
  // Weighs the test-level incremental advantage as the primary signal, per the real pilot's finding
  // that coarse task-level reduction hides DiffCI's actual (dependency-graph) advantage - see
  // docs/research/2026-08-19-stage0-real-pilot.md. Task-level incremental is kept as a secondary,
  // less-weighted input rather than dropped, since it's still a legitimate (if weaker) signal.
  const medianIncrementalTest = median(incrementalTest);
  const combinedIncremental = Math.max(medianIncrementalTest, medianIncremental);
  let materialOutperformance: Stage0Verdict["materialOutperformance"] = "NO MATERIAL ADVANTAGE";
  if (combinedIncremental > 0.15) materialOutperformance = "LARGE ADVANTAGE";
  else if (combinedIncremental > 0.08) materialOutperformance = "MATERIAL ADVANTAGE";
  else if (combinedIncremental > 0.03) materialOutperformance = "MODEST ADVANTAGE";

  // "Does the advantage persist across repository types, or come mainly from a few repositories?" -
  // counts repos whose OWN median test-level incremental advantage clears a meaningful bar, so a
  // single outlier repo can't make the whole corpus look like it generalizes.
  const perRepoTestAdvantage = analyzed.map((r) => {
    const recs = r.records.filter((rec) => rec.testsTotal > 0);
    const perRecordIncremental = recs.map((rec) =>
      Math.max(0, (rec.testsTotal - rec.testsSelectedByDiffci) / rec.testsTotal - (rec.testsTotal - rec.testsSelectedByPath) / rec.testsTotal),
    );
    return { repo: r.metadata.repository, advantage: median(perRecordIncremental) };
  });
  const repositoriesWithMeaningfulAdvantage = perRepoTestAdvantage.filter((r) => r.advantage > 0.05).length;
  const generalizesOutsideDentalPresence = repositoriesWithMeaningfulAdvantage >= 2;

  const byBenefit = analyzed
    .map((r) => ({ repo: r.metadata.repository, reduction: median(r.records.map((rec) => rec.taskReduction.fullVsDiffci)) }))
    .sort((a, b) => b.reduction - a.reduction);

  const testAdvantageNote =
    testReductionsByDiffci.length > 0
      ? `Median test-level DiffCI reduction is ${(median(testReductionsByDiffci) * 100).toFixed(1)}%, with a ${(medianIncrementalTest * 100).toFixed(1)}% median incremental advantage over PATH at the test level (the primary signal - see the 2026-08-19 pilot).`
      : "No test-level counts were available in this run.";

  const explanationParts = [
    `Median task reduction vs. FULL is ${(medianReduction * 100).toFixed(1)}%.`,
    `Median incremental task advantage over path baseline is ${(medianIncremental * 100).toFixed(1)}%.`,
    testAdvantageNote,
    diffciUnsafeMisses > 0 || pathUnsafeMisses > 0
      ? `Historical failure recall found ${diffciUnsafeMisses} DiffCI unsafe misses and ${pathUnsafeMisses} PATH unsafe misses.`
      : "Historical failure recall found no unsafe misses in the deltas with usable evidence (see historicalFailures/historicalFailingDeltas for the evaluated denominator).",
  ];

  const records = analyzed.flatMap((r) => r.records);
  const fallbackRecords = records.filter((r) => r.fallback);
  return {
    materialOutperformance,
    fallbackRate: records.length === 0 ? 0 : fallbackRecords.length / records.length,
    topFallbackReasons: topFallbackReasons.slice(0, 3),
    repositoryMostBenefit: byBenefit[0]?.repo ?? "N/A",
    repositoryLeastBenefit: byBenefit.at(-1)?.repo ?? "N/A",
    diffciUnsafeMisses,
    pathUnsafeMisses,
    generalizesOutsideDentalPresence,
    cloudflareCostJustifiesStage1: budgetStatus !== "BUDGET_STOPPED",
    proceedTo100Repositories: "PROCEED WITH CHANGES",
    explanation: explanationParts.join(" "),
  };
}

function computeProceedRecommendation(summary: Stage0Summary): Stage0Summary["proceedToStage1"] {
  if (summary.repositoriesAnalyzed < 10 || summary.uniqueCommitDeltas < 500) return "STOP";
  if (summary.verdict.diffciUnsafeMisses > 0 || summary.budgetGuardTriggered) return "PROCEED WITH CHANGES";
  // Weighs both signals: task-level reduction alone previously drove this decision and could
  // contradict the real (test-level) signal the pilot found - see docs/research/2026-08-19 and the
  // 2026-08-20 architecture doc §5. Either signal clearing its bar is enough to proceed; neither
  // clearing it means the coarse and fine-grained views agree DiffCI isn't showing an advantage yet.
  const taskSignalWeak = summary.medianTaskReduction < 0.05;
  const testSignalWeak = summary.medianTestReductionByDiffci < 0.3 || summary.diffciIncrementalTestAdvantage < 0.05;
  if (taskSignalWeak && testSignalWeak) return "PROCEED WITH CHANGES";
  return "PROCEED";
}

export function buildRepoResult(result: import("./runner.js").RepoBenchmarkResult): RepositoryResult {
  const records = result.records;
  return {
    metadata: result.metadata,
    commitsAnalyzed: records.length,
    fallbackRate: records.length === 0 ? 0 : records.filter((r) => r.fallback).length / records.length,
    medianTaskReduction: median(records.map((r) => r.taskReduction.fullVsDiffci)),
    medianRuntimeOpportunity: undefined,
    pathBaselineMedianReduction: median(records.map((r) => r.taskReduction.fullVsPath)),
    diffciIncrementalAdvantage: median(records.map((r) => Math.max(0, r.taskReduction.fullVsDiffci - r.taskReduction.fullVsPath))),
    failureEvents: records.reduce((sum, r) => sum + (r.historicalFailedTargets?.length ?? 0), 0),
    unsafeMisses: records.reduce((sum, r) => sum + (r.historicalUnsafeMissTargets?.length ?? 0), 0),
    records,
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const k = (sorted.length - 1) * (p / 100);
  const f = Math.floor(k);
  const c = Math.ceil(k);
  if (f === c) return sorted[k]!;
  return sorted[f]! * (c - k) + sorted[c]! * (k - f);
}

export function median(values: number[]): number {
  return percentile(values, 50);
}

function collectProblems(repoResults: RepositoryResult[]): string[] {
  const problems = new Map<string, number>();
  for (const r of repoResults) {
    if (r.metadata.exclusionReason) {
      problems.set(r.metadata.exclusionReason, (problems.get(r.metadata.exclusionReason) ?? 0) + 1);
    }
    for (const rec of r.records) {
      for (const reason of rec.fallbackReasons) {
        problems.set(reason, (problems.get(reason) ?? 0) + 1);
      }
    }
  }
  return Array.from(problems.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([p, n]) => `${n}: ${p}`)
    .slice(0, 10);
}

function collectFallbackReasons(allRecords: BenchmarkRecord[]): string[] {
  const counts = new Map<string, number>();
  for (const r of allRecords) {
    if (!r.fallback) continue;
    for (const reason of r.fallbackReasons) {
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${reason} (${count})`)
    .slice(0, 5);
}
