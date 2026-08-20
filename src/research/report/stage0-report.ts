import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Stage0Report } from "../types.js";

export function writeStage0Report(report: Stage0Report, outputDir: string): void {
  const summaryPath = resolve(outputDir, "summary.json");
  const mdPath = resolve(outputDir, "summary.md");
  writeFileSync(summaryPath, JSON.stringify(report.summary, null, 2), "utf8");
  writeFileSync(mdPath, renderMarkdown(report), "utf8");
}

function renderMarkdown(report: Stage0Report): string {
  const s = report.summary;
  const lines: string[] = [];
  lines.push(`# DiffCI Open Source CI Efficiency Study — Stage 0 Report`);
  lines.push("");
  lines.push(`- Experiment ID: \`${s.experimentId}\``);
  lines.push(`- DiffCI version: \`${s.diffciVersion}\``);
  lines.push(`- Schema version: \`${s.schemaVersion}\``);
  lines.push(`- Generated at: ${s.generatedAt}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| Repositories selected | ${s.repositoriesSelected} |`);
  lines.push(`| Repositories successfully analyzed | ${s.repositoriesAnalyzed} |`);
  lines.push(`| Repositories excluded | ${s.repositoriesExcluded} |`);
  lines.push(`| Unique commit deltas | ${s.uniqueCommitDeltas} |`);
  lines.push(`| Duplicate analyses dropped (not counted in aggregation) | ${s.duplicateAnalyses} |`);
  lines.push(`| FULL commits (DiffCI = FULL) | ${s.fullCommits} |`);
  lines.push(`| SELECTIVE commits (DiffCI < FULL) | ${s.selectiveCommits} |`);
  lines.push(`| Fallback rate | ${formatPercent(s.fallbackRate)} |`);
  lines.push(`| Median task reduction (DiffCI vs FULL) | ${formatPercent(s.medianTaskReduction)} |`);
  lines.push(`| Path baseline median reduction | ${formatPercent(s.pathBaselineReduction)} |`);
  lines.push(`| DiffCI incremental advantage over path | ${formatPercent(s.diffciIncrementalAdvantage)} |`);
  lines.push(`| Tests total / selected by PATH / selected by DiffCI (sum across deltas) | ${s.testsTotalAcrossDeltas} / ${s.testsSelectedByPathAcrossDeltas} / ${s.testsSelectedByDiffciAcrossDeltas} |`);
  lines.push(`| Median test reduction (PATH vs DiffCI) | ${formatPercent(s.medianTestReductionByPath)} vs ${formatPercent(s.medianTestReductionByDiffci)} |`);
  lines.push(`| DiffCI incremental test advantage over path | ${formatPercent(s.diffciIncrementalTestAdvantage)} |`);
  lines.push(`| Cache hit rate | ${formatPercent(s.cacheHitRate)} |`);
  lines.push(`| Cold analysis p50 / p90 | ${s.coldAnalysisP50Ms.toFixed(0)} ms / ${s.coldAnalysisP90Ms.toFixed(0)} ms |`);
  lines.push(`| Warm analysis p50 / p90 | ${s.warmAnalysisP50Ms.toFixed(0)} ms / ${s.warmAnalysisP90Ms.toFixed(0)} ms |`);
  lines.push(`| DiffCI overhead median | ${s.diffciOverheadMedianMs.toFixed(0)} ms |`);
  lines.push(`| Historical failures evaluable / preserved by DiffCI | ${s.historicalFailures} / ${s.historicalFailures - s.unsafeMisses} (recall: ${formatRecall(s.observedDiffciFailureRecall)}) |`);
  lines.push(`| Historical failures preserved by PATH baseline | ${s.historicalFailures - s.pathUnsafeMisses} / ${s.historicalFailures} (recall: ${formatRecall(s.observedPathFailureRecall)}) |`);
  lines.push(`| Cloudflare spend - measured (exact op counts x published rates) | $${s.measuredSpendUsd.toFixed(4)} |`);
  lines.push(`| Cloudflare spend - estimated (CPU-ms, wall-clock proxy) | $${s.estimatedSpendUsd.toFixed(4)} |`);
  lines.push(`| Cloudflare spend - projected remaining (avg-per-delta x remaining, +20% margin) | ${s.projectedRemainingSpendUsd === undefined ? "N/A" : `$${s.projectedRemainingSpendUsd.toFixed(4)}`} |`);
  lines.push(`| Budget status (of 2,000-credit ceiling, 1 credit ~= $1) | **${s.budgetStatus}** |`);
  lines.push(`| Proceed to Stage 1 | **${s.proceedToStage1}** |`);
  lines.push("");
  lines.push("## Repository Results");
  lines.push("");
  lines.push(`| Repository | Language | Framework | Size | Deltas | Fallback rate | Median reduction |`);
  lines.push(`|---|---|---|---|---|---|---|`);
  for (const r of report.repositoryResults) {
    lines.push(`| ${r.metadata.repository} | ${r.metadata.primaryLanguage} | ${r.metadata.framework} | ${r.metadata.sizeClass} | ${r.commitsAnalyzed} | ${formatPercent(r.fallbackRate)} | ${formatPercent(r.medianTaskReduction)} |`);
  }
  lines.push("");
  lines.push("## Exclusions");
  lines.push("");
  if (report.excludedRepositories.length === 0) {
    lines.push("No repositories were excluded.");
  } else {
    for (const e of report.excludedRepositories) {
      lines.push(`- **${e.repository}**: ${e.exclusionReason ?? "analyzed 0 commits"}`);
    }
  }
  lines.push("");
  lines.push("## Top Technical Problems");
  lines.push("");
  if (s.topTechnicalProblems.length === 0) {
    lines.push("None recorded.");
  } else {
    for (const p of s.topTechnicalProblems) lines.push(`- ${p}`);
  }
  lines.push("");
  lines.push("## Final Questions");
  lines.push("");
  lines.push(`A. Material outperformance over path baseline: **${s.verdict.materialOutperformance}**`);
  lines.push(`B. Median NET runtime opportunity: ${formatOptionalMs(s.verdict.medianNetRuntimeOpportunityMs)}`);
  lines.push(`C. Fallback rate: ${formatPercent(s.verdict.fallbackRate)}`);
  lines.push(`D. Top three fallback causes: ${s.verdict.topFallbackReasons.join("; ") || "N/A"}`);
  lines.push(`E. Repository benefiting most: **${s.verdict.repositoryMostBenefit}**`);
  lines.push(`F. Repository benefiting least: **${s.verdict.repositoryLeastBenefit}**`);
  lines.push(`G. DiffCI unsafe misses: ${s.verdict.diffciUnsafeMisses}`);
  lines.push(`H. Path unsafe misses: ${s.verdict.pathUnsafeMisses}`);
  lines.push(`I. Generalizes outside DentalPresence: ${s.verdict.generalizesOutsideDentalPresence ? "Yes" : "No"}`);
  lines.push(`J. Cloudflare cost justifies Stage 1: ${s.verdict.cloudflareCostJustifiesStage1 ? "Yes" : "No"}`);
  lines.push(`K. Proceed to ~100 repositories: **${s.verdict.proceedTo100Repositories}**`);
  lines.push(`> ${s.verdict.explanation}`);
  lines.push("");
  lines.push("## Final Product Verdict");
  lines.push("");
  lines.push("```text");
  lines.push("DIFFCI STAGE 0 VERDICT");
  lines.push("");
  lines.push(`Repositories: ${s.repositoriesAnalyzed}`);
  lines.push(`Unique commit deltas: ${s.uniqueCommitDeltas}`);
  lines.push(`DiffCI selective rate: ${formatPercent(s.selectiveCommits / Math.max(1, s.uniqueCommitDeltas))}`);
  lines.push(`DiffCI fallback rate: ${formatPercent(s.fallbackRate)}`);
  lines.push(`Median task reduction: ${formatPercent(s.medianTaskReduction)}`);
  lines.push(`Median net runtime opportunity: ${formatOptionalMs(s.medianNetRuntimeOpportunityMs)}`);
  lines.push(`Path baseline reduction: ${formatPercent(s.pathBaselineReduction)}`);
  lines.push(`DiffCI incremental advantage: ${formatPercent(s.diffciIncrementalAdvantage)}`);
  lines.push(`Historical failures evaluable: ${s.historicalFailures} (across ${s.historicalFailingDeltas} deltas with usable evidence)`);
  lines.push(`Unsafe misses: ${s.unsafeMisses} (DiffCI recall: ${formatRecall(s.observedDiffciFailureRecall)})`);
  lines.push(`Stage 0 Cloudflare spend: $${s.cloudflareSpendUsd.toFixed(4)} (measured $${s.measuredSpendUsd.toFixed(4)} + estimated $${s.estimatedSpendUsd.toFixed(4)})`);
  lines.push(`Budget status: ${s.budgetStatus}`);
  lines.push(`Cost / 1,000 commits: $${(s.costPer1000CommitsUsd ?? 0).toFixed(2)}`);
  lines.push(`Technical signal: ${s.repositoriesAnalyzed >= 10 && s.uniqueCommitDeltas >= 500 ? "POSITIVE" : "INSUFFICIENT DATA"}`);
  lines.push(`Safety signal: ${s.unsafeMisses === 0 ? "NO OBSERVED UNSAFE MISSES" : "NEEDS INVESTIGATION"}`);
  lines.push(`Economic signal: ${s.verdict.cloudflareCostJustifiesStage1 ? "LOW COST" : "REVIEW COST"}`);
  lines.push(`Recommendation: ${s.proceedToStage1}`);
  lines.push("```");
  lines.push("");
  lines.push("## Reproducibility");
  lines.push("");
  lines.push(`All raw records, manifests, and reports are stored under \`${s.experimentId}\` in the evidence store. Each commit delta is keyed by its deterministic logical delta key.`);
  return lines.join("\n");
}

function formatPercent(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function formatOptionalMs(value: number | undefined): string {
  return value === undefined ? "NOT MEASURABLE" : `${value.toFixed(0)} ms`;
}

function formatRecall(value: "NOT MEASURABLE" | number | undefined): string {
  if (value === undefined || value === "NOT MEASURABLE") return "NOT MEASURABLE";
  return `${value.toFixed(1)}%`;
}

