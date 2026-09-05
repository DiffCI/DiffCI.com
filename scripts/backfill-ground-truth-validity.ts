/**
 * Re-labels UNVERIFIED shadow_ground_truth rows (every row written before the 2026-09-05 workflow
 * identity fix) against the repository's now-explicit evidence workflow, using GitHub's own record of
 * the run each row was reconciled from - measurement-integrity repair step 2, backfill half.
 *
 * Rule per row (repository must have evidence_workflow_paths configured, otherwise the row is left
 * UNVERIFIED and reported):
 *   - GitHub's run `path` is one of the evidence workflows AND its conclusion is success|failure
 *       -> VERIFIED (identity proven by GitHub; evidence_workflow_path filled in)
 *   - otherwise (another workflow, or skipped/cancelled/anything that did not execute)
 *       -> CONTAMINATED_WORKFLOW_IDENTITY (kept, never deleted, never counted)
 *   - run not found on GitHub / API error -> left UNVERIFIED, reported
 *
 * Dry run by default - prints the would-be labels. `--apply` writes them (UPDATE only, one row at a
 * time, never a DELETE). Reads via `wrangler d1 execute --remote --json`, GitHub via `gh api`.
 *
 * Usage: npx tsx scripts/backfill-ground-truth-validity.ts --repository owner/name [--apply] [--limit N]
 */
import { execFileSync } from "node:child_process";

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

function ghRun(repository: string, runId: string): { path?: string; conclusion?: string | null; status?: string } | undefined {
  try {
    const out = execFileSync("gh", ["api", `repos/${repository}/actions/runs/${runId}`, "--jq", "{path,conclusion,status}"], { encoding: "utf8" });
    return JSON.parse(out) as { path?: string; conclusion?: string | null; status?: string };
  } catch {
    return undefined;
  }
}

const args = parseArgs(process.argv.slice(2));
const repository = typeof args.repository === "string" ? args.repository : "";
if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repository)) {
  console.error("--repository owner/name required");
  process.exit(2);
}
const apply = args.apply === true;
const limit = typeof args.limit === "string" ? Math.max(1, Number.parseInt(args.limit, 10) || 0) : 10_000;

const repoRow = d1<{ evidence_workflow_paths: string | null }>(`SELECT evidence_workflow_paths FROM shadow_repositories WHERE repository = ${sqlString(repository)}`)[0];
const evidencePaths: string[] = repoRow?.evidence_workflow_paths ? (JSON.parse(repoRow.evidence_workflow_paths) as string[]) : [];
if (evidencePaths.length === 0) {
  console.error(`${repository} has no evidence workflow configured - nothing can be verified; configure it first (POST /v1/shadow/evidence-workflow).`);
  process.exit(1);
}
console.log(`${repository}: evidence workflows = ${evidencePaths.join(", ")}  mode = ${apply ? "APPLY" : "dry run"}`);

const rows = d1<{ logical_event_key: string; workflow_run_id: string | null; workflow_conclusion: string | null }>(
  `SELECT logical_event_key, workflow_run_id, workflow_conclusion FROM shadow_ground_truth
   WHERE repository = ${sqlString(repository)} AND evidence_validity = 'UNVERIFIED' ORDER BY created_at ASC LIMIT ${limit}`,
);
console.log(`UNVERIFIED rows to examine: ${rows.length}`);

const tally = { VERIFIED: 0, CONTAMINATED_WORKFLOW_IDENTITY: 0, left_unverified: 0 };
const samples: string[] = [];
for (const row of rows) {
  if (!row.workflow_run_id) {
    tally.left_unverified++;
    continue;
  }
  const run = ghRun(repository, row.workflow_run_id);
  if (!run || typeof run.path !== "string") {
    tally.left_unverified++;
    samples.push(`${row.logical_event_key}: run ${row.workflow_run_id} not resolvable on GitHub - left UNVERIFIED`);
    continue;
  }
  const executed = run.conclusion === "success" || run.conclusion === "failure";
  const identity = evidencePaths.includes(run.path);
  const label = identity && executed ? "VERIFIED" : "CONTAMINATED_WORKFLOW_IDENTITY";
  tally[label]++;
  if (samples.length < 12) samples.push(`${row.logical_event_key.slice(-60)}: run ${row.workflow_run_id} ${run.path} ${run.conclusion} -> ${label}`);
  if (apply) {
    d1(`UPDATE shadow_ground_truth SET evidence_validity = ${sqlString(label)}, evidence_workflow_path = ${sqlString(run.path)} WHERE logical_event_key = ${sqlString(row.logical_event_key)} AND evidence_validity = 'UNVERIFIED'`);
  }
}
console.log(JSON.stringify(tally));
for (const s of samples) console.log("  " + s);
if (!apply) console.log("dry run - re-run with --apply to write these labels");
