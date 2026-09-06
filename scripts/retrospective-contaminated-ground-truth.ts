/**
 * Builds the retrospective dataset for a repository's CONTAMINATED_WORKFLOW_IDENTITY ground-truth rows
 * (2026-09-06) - the separate dataset the measurement-integrity note reserved for "if ever needed".
 *
 * READ-ONLY against production: every D1 statement is a SELECT (via `wrangler d1 execute --remote --json`),
 * every GitHub call a GET (via `gh api`). It never writes to shadow_ground_truth or any other table. Output
 * is files under docs/evidence/retrospective-contaminated-ground-truth/<owner>--<repo>/:
 *   rows.json     one RetrospectiveRow per contaminated row, with the whole run field for its head
 *   rows.csv      the same, flat
 *   summary.json  tallies + provenance (when, which evidence workflows, how many GitHub calls)
 *
 * Usage: npx tsx scripts/retrospective-contaminated-ground-truth.ts --repository owner/name [--limit N]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { classifyRetrospective, summarize, toCsv, type ContaminatedRowInput, type GitHubRunSummary, type RetrospectiveRow } from "../src/shadow/retrospective-evidence.js";

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[a.slice(2)] = next;
      i++;
    } else args[a.slice(2)] = true;
  }
  return args;
}

function d1<T>(sql: string): T[] {
  if (!/^\s*SELECT\b/i.test(sql)) throw new Error("this script only reads");
  const out = execFileSync(
    process.execPath,
    ["node_modules/wrangler/bin/wrangler.js", "d1", "execute", "diffci-research", "--remote", "--config", "wrangler.research-sandbox.jsonc", "--command", sql, "--json"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const start = out.indexOf("[");
  return (JSON.parse(out.slice(start)) as { results: T[] }[])[0]?.results ?? [];
}

function sqlString(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

let githubCalls = 0;
function runsForHead(repository: string, headSha: string): GitHubRunSummary[] | undefined {
  githubCalls++;
  try {
    const out = execFileSync(
      "gh",
      ["api", `repos/${repository}/actions/runs?head_sha=${headSha}&per_page=100`, "--jq", ".workflow_runs | map({id, path, conclusion, status, createdAt: .created_at, runStartedAt: .run_started_at, updatedAt: .updated_at, event, runAttempt: .run_attempt})"],
      { encoding: "utf8" },
    );
    return JSON.parse(out) as GitHubRunSummary[];
  } catch {
    return undefined;
  }
}

const args = parseArgs(process.argv.slice(2));
const repository = typeof args.repository === "string" ? args.repository : "";
if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(repository)) {
  console.error("--repository owner/name required");
  process.exit(2);
}
const limit = typeof args.limit === "string" ? Math.max(1, Number.parseInt(args.limit, 10) || 0) : 10_000;

const repoRow = d1<{ evidence_workflow_paths: string | null; evidence_workflow_source: string | null }>(`SELECT evidence_workflow_paths, evidence_workflow_source FROM shadow_repositories WHERE repository = ${sqlString(repository)}`)[0];
const evidencePaths: string[] = repoRow?.evidence_workflow_paths ? (JSON.parse(repoRow.evidence_workflow_paths) as string[]) : [];
if (evidencePaths.length === 0) {
  console.error(`${repository}: no evidence workflow identified - there is no rule to be retrospective against.`);
  process.exit(1);
}

interface Row {
  logical_event_key: string;
  head_sha: string;
  workflow_run_id: string | null;
  evidence_workflow_path: string | null;
  workflow_conclusion: string | null;
  created_at: string;
  prediction_created_at: string;
  plan_mode: string;
  tests_selected_diffci: number;
  tests_total_full: number;
}
const rows = d1<Row>(
  `SELECT g.logical_event_key, g.head_sha, g.workflow_run_id, g.evidence_workflow_path, g.workflow_conclusion, g.created_at,
          p.prediction_created_at, p.plan_mode, p.tests_selected_diffci, p.tests_total_full
   FROM shadow_ground_truth g JOIN shadow_predictions p ON p.logical_delta_key = g.logical_delta_key
   WHERE g.repository = ${sqlString(repository)} AND g.evidence_validity = 'CONTAMINATED_WORKFLOW_IDENTITY'
   ORDER BY g.created_at ASC LIMIT ${limit}`,
);
console.log(`${repository}: evidence workflows ${evidencePaths.join(", ")} (${repoRow?.evidence_workflow_source ?? "?"}); contaminated rows: ${rows.length}`);

const byHead = new Map<string, GitHubRunSummary[] | undefined>();
const out: RetrospectiveRow[] = [];
for (const row of rows) {
  if (!byHead.has(row.head_sha)) byHead.set(row.head_sha, runsForHead(repository, row.head_sha));
  const input: ContaminatedRowInput = {
    logicalEventKey: row.logical_event_key,
    headSha: row.head_sha,
    recordedRunId: row.workflow_run_id,
    recordedRunPath: row.evidence_workflow_path,
    recordedConclusion: row.workflow_conclusion,
    predictionCreatedAt: row.prediction_created_at,
    planMode: row.plan_mode,
    testsSelectedDiffci: row.tests_selected_diffci,
    testsTotalFull: row.tests_total_full,
  };
  out.push(classifyRetrospective(input, evidencePaths, byHead.get(row.head_sha)));
}

const summary = {
  repository,
  builtAt: new Date().toISOString(),
  evidenceWorkflowPaths: evidencePaths,
  evidenceWorkflowSource: repoRow?.evidence_workflow_source ?? null,
  rule: "earliest-created run of an evidence workflow for the head that executed (success|failure); precedence = prediction_created_at < that run's created_at",
  githubCalls,
  distinctHeads: byHead.size,
  productionWrites: 0,
  ...summarize(out),
};
const dir = join("docs", "evidence", "retrospective-contaminated-ground-truth", repository.replace("/", "--"));
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "rows.json"), JSON.stringify(out, null, 2) + "\n");
writeFileSync(join(dir, "rows.csv"), toCsv(out));
writeFileSync(join(dir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
console.log(`written: ${dir}/rows.json, rows.csv, summary.json`);
