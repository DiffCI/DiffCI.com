import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildBenchmarkReport, fromShadowRecord } from "../src/shadow/benchmark.js";
import type { ShadowRunRecord } from "../src/shadow/types.js";
import { resolveDentalPresenceRepoPath } from "./target-repo.js";

const repoPath = resolveDentalPresenceRepoPath();
const shadowDir = resolve(repoPath, ".diffci/shadow");
const reportPath = resolve(repoPath, ".diffci/reports/phase5-benchmark-report.json");

function readShadowJsonl(): ShadowRunRecord[] {
  const file = `${shadowDir}/shadow-runs.jsonl`;
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ShadowRunRecord);
}

function formatMarkdown(report: ReturnType<typeof buildBenchmarkReport>): string {
  const a = report.aggregate;
  const s = report.aggregateSelectiveOnly;
  return `# DentalPresence DiffCI Phase 5 Benchmark Report\n\nGenerated: ${report.generatedAt}\nSample: ${report.sampleSize} latest non-merge commits\n\n## Aggregate\n
- Selective commits: **${a.selectiveCommits}** (${a.selectivePercentage.toFixed(1)}%)\n- Fallback commits: **${a.fallbackCommits}** (${a.fallbackPercentage.toFixed(1)}%)\n- Mean selected-test percent (selective-only): **${a.meanSelectedTestPercent.toFixed(1)}%**\n- Median selected-test percent (selective-only): **${a.medianSelectedTestPercent.toFixed(1)}%**\n- P75 selected-test percent (selective-only): **${a.p75SelectedTestPercent.toFixed(1)}%**\n- P90 selected-test percent (selective-only): **${a.p90SelectedTestPercent.toFixed(1)}%**\n- Mean reduction vs full baseline: **${a.meanPotentialTestReduction.toFixed(1)}%**\n- Mean reduction vs path-baseline: **${a.meanDiffCiAdvantage.toFixed(1)} percentage points**\n\n## Selective-only aggregate\n
- Mean selected-test percent: **${s?.meanSelectedTestPercent.toFixed(1)}%**\n- Mean potential reduction: **${s?.meanPotentialTestReduction.toFixed(1)}%**\n\n## Category breakdown\n\n| Category | Commits | Fallback rate | Mean selected-tests | Median selected-tests |\n|---|---:|---:|---:|---:|\n${report.categories
      .map(
        (c) =>
          `| ${c.category} | ${c.commits} | ${c.fallbackRate.toFixed(1)}% | ${c.meanSelectedTestPercent.toFixed(1)}% | ${c.medianSelectedTestPercent.toFixed(1)}% |`,
      )
      .join("\n")}\n`;
}

async function main() {
  const records = readShadowJsonl();
  if (records.length === 0) {
    console.error("No shadow records found. Run 'diffci benchmark' first.");
    process.exit(1);
  }

  const runs = records.map((r) => fromShadowRecord(r));
  const report = buildBenchmarkReport(runs);

  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  const mdPath = reportPath.replace(/\.json$/, ".md");
  writeFileSync(mdPath, formatMarkdown(report));

  console.log(JSON.stringify({
    sampleSize: report.sampleSize,
    selectivePercentage: report.aggregate.selectivePercentage,
    fallbackPercentage: report.aggregate.fallbackPercentage,
    meanSelectedTestPercent: report.aggregate.meanSelectedTestPercent,
    medianSelectedTestPercent: report.aggregate.medianSelectedTestPercent,
    meanTestReduction: report.aggregate.meanPotentialTestReduction,
    meanDiffCiAdvantage: report.aggregate.meanDiffCiAdvantage,
    reportPath,
    markdownPath: mdPath,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
