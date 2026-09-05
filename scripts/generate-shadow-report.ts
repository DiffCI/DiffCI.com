/**
 * Generates a real seven-day shadow report for one repository from live production data (External Shadow
 * Pilot M3, 2026-08-26).
 *
 * Reads diffci-research via `wrangler d1 execute --remote --json`, deliberately rather than by adding an
 * HTTP route to the Worker: M3's deliverable is report GENERATION, and the founder-operated delivery step
 * is explicitly manual for the first ten repositories. A route can come later if this is ever automated.
 *
 * Read-only by construction - every statement issued here is a SELECT.
 *
 * Usage: npx tsx scripts/generate-shadow-report.ts --repository unjs/h3 [--days 7] [--out report.txt]
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { rollUpShadowReport } from "../src/usage/shadow-report-rollup.js";
import { renderShadowReport } from "../src/usage/shadow-report-render.js";
import type { ShadowEconomicsObservation } from "../src/usage/shadow-economics.js";
import type { CiStage } from "../src/shadow/stage-classification.js";
import type { EvidenceTier } from "../src/usage/economics-classification.js";
import type { SavingsConfidence } from "../src/usage/savings.js";

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a?.startsWith("--")) args[a.slice(2)] = argv[++i] ?? "";
  }
  return args;
}

function d1Query<T>(sql: string): T[] {
  const out = execFileSync(
    process.execPath,
    ["node_modules/wrangler/bin/wrangler.js", "d1", "execute", "diffci-research", "--remote", "--config", "wrangler.research-sandbox.jsonc", "--command", sql, "--json"],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  // wrangler prints a JSON array of result envelopes, sometimes preceded by banner lines.
  const start = out.indexOf("[");
  const parsed = JSON.parse(out.slice(start)) as { results: T[] }[];
  return parsed[0]?.results ?? [];
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

interface RawRow {
  logical_delta_key: string;
  stage: string;
  repository: string;
  head_sha: string;
  workflow_run_ids: string;
  job_ids: string;
  full_workload_ms: number;
  tests_total_full: number | null;
  tests_selected_diffci: number | null;
  tests_selected_path: number | null;
  diffci_analysis_overhead_ms: number | null;
  plan_mode: string | null;
  selected_workload_ms: number | null;
  selected_workload_confidence: string | null;
  avoidable_ms: number | null;
  avoidable_tier: string;
  estimation_method: string | null;
  estimator_version: number | null;
  estimated_at: string | null;
  schema_version: number;
  observed_at: string;
}

function toObservation(row: RawRow): ShadowEconomicsObservation {
  const ids = (v: string): number[] => {
    try {
      const p: unknown = JSON.parse(v);
      return Array.isArray(p) ? p.filter((x): x is number => typeof x === "number") : [];
    } catch {
      return [];
    }
  };
  return {
    logicalDeltaKey: row.logical_delta_key,
    stage: row.stage as CiStage,
    repository: row.repository,
    headSha: row.head_sha,
    workflowRunIds: ids(row.workflow_run_ids),
    jobIds: ids(row.job_ids),
    fullWorkloadMs: row.full_workload_ms,
    testsTotalFull: row.tests_total_full ?? undefined,
    testsSelectedDiffci: row.tests_selected_diffci ?? undefined,
    testsSelectedPath: row.tests_selected_path ?? undefined,
    diffciAnalysisOverheadMs: row.diffci_analysis_overhead_ms ?? undefined,
    planMode: (row.plan_mode as "FULL" | "SELECTIVE" | null) ?? undefined,
    selectedWorkloadMs: row.selected_workload_ms ?? undefined,
    selectedWorkloadConfidence: (row.selected_workload_confidence as SavingsConfidence | null) ?? undefined,
    avoidableMs: row.avoidable_ms ?? undefined,
    avoidableTier: row.avoidable_tier as EvidenceTier,
    estimationMethod: row.estimation_method ?? undefined,
    estimatorVersion: row.estimator_version ?? undefined,
    estimatedAt: row.estimated_at ?? undefined,
    schemaVersion: row.schema_version,
    observedAt: row.observed_at,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repository = args.repository;
  if (!repository) throw new Error("--repository required, e.g. --repository unjs/h3");
  const days = Number(args.days ?? "7");
  const now = new Date();
  const windowEndIso = now.toISOString();
  const windowStartIso = new Date(now.getTime() - days * 86_400_000).toISOString();

  // Eligible = predictions DiffCI generated for this repository in the window. This is the coverage
  // DENOMINATOR, and it is what turns "3 commits observed" into a meaningful statement.
  const eligible = d1Query<{ n: number }>(
    `SELECT COUNT(*) as n FROM shadow_predictions WHERE repository = ${sqlString(repository)} AND created_at >= ${sqlString(windowStartIso)} AND created_at < ${sqlString(windowEndIso)}`,
  );
  const eligiblePredictions = eligible[0]?.n ?? 0;

  // Observations are selected by their PREDICTION's window membership, not by capture time, so the
  // numerator and denominator describe the same set of commits. Filtering economics rows by observed_at
  // would drift: a commit predicted inside the window but captured just after it would vanish from the
  // numerator while remaining in the denominator, understating coverage for no real reason.
  // 2026-09-05 (measurement-integrity repair step 3): reports read shadow_stage_economics ONLY - rows
  // derived from VERIFIED ground truth, the evidence run's own jobs, and the repository's explicit
  // stage classification. The legacy shadow_economics_observations table (labelled LEGACY_UNVERIFIED)
  // is never read here. Legacy column names are aliased so the rollup input is unchanged.
  const rows = d1Query<RawRow>(
    `SELECT e.logical_delta_key, e.stage, e.repository, e.head_sha,
            '[' || e.evidence_run_id || ']' AS workflow_run_ids, e.job_ids, e.full_workload_ms,
            e.tests_total_full, e.tests_selected_diffci, e.tests_selected_path, e.diffci_analysis_overhead_ms, e.plan_mode,
            e.selected_workload_ms, e.selected_workload_confidence, e.avoidable_ms, e.avoidable_tier, e.estimation_method,
            e.estimator_version, e.observed_at AS estimated_at, 2 AS schema_version, e.observed_at,
            e.classification_basis, e.evidence_workflow_path
     FROM shadow_stage_economics e
     JOIN shadow_predictions p ON p.logical_delta_key = e.logical_delta_key
     WHERE e.repository = ${sqlString(repository)} AND e.evidence_validity = 'VERIFIED'
       AND p.created_at >= ${sqlString(windowStartIso)} AND p.created_at < ${sqlString(windowEndIso)}
     ORDER BY e.observed_at ASC`,
  );

  // Safety comes from Stage 2F's own reconciliation, not from the economics table - the economics layer
  // never re-derives a safety verdict.
  const safetyRows = d1Query<{ evaluable: number; preserved: number }>(
    `SELECT COALESCE(SUM(g.relevant_failures_evaluable), 0) as evaluable, COALESCE(SUM(g.failures_preserved_by_diffci), 0) as preserved
     FROM shadow_ground_truth g JOIN shadow_predictions p ON p.logical_delta_key = g.logical_delta_key
     WHERE p.repository = ${sqlString(repository)} AND g.evidence_validity = 'VERIFIED'`,
  );
  const evaluableFailures = safetyRows[0]?.evaluable ?? 0;
  const failuresPreserved = safetyRows[0]?.preserved ?? 0;

  const report = rollUpShadowReport({
    repository,
    windowStartIso,
    windowEndIso,
    observations: rows.map(toObservation),
    eligiblePredictions,
    safety: { evaluableFailures, failuresPreserved, falseNegatives: Math.max(0, evaluableFailures - failuresPreserved) },
  });

  const text = renderShadowReport(report);
  console.log(text);
  if (args.out) {
    writeFileSync(args.out, text + "\n", "utf8");
    console.log(`\n[written to ${args.out}]`);
  }
  console.log(`\n[traceability: ${rows.length} shadow_economics_observations rows in window]`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
