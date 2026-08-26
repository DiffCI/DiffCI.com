/**
 * Operational status of the shadow pilot: launch budget, liveness, coverage and economics in one
 * command. Read-only - every statement is a SELECT.
 *
 * Usage: npm run shadow:status
 */
import { execFileSync } from "node:child_process";
const d1 = (sql) => {
  const o = execFileSync(process.execPath, ["node_modules/wrangler/bin/wrangler.js","d1","execute","diffci-research","--remote","--config","wrangler.research-sandbox.jsonc","--command",sql,"--json"], { encoding: "utf8", maxBuffer: 32e6 });
  return JSON.parse(o.slice(o.indexOf("[")))[0]?.results ?? [];
};
const dayStart = new Date(); dayStart.setUTCHours(0,0,0,0);
const since = dayStart.toISOString();

const day = new Date().toISOString().slice(0,10);
const slots = d1(`SELECT COUNT(*) as n, SUM(CASE WHEN outcome='succeeded' THEN 1 ELSE 0 END) as ok, SUM(CASE WHEN outcome='failed' THEN 1 ELSE 0 END) as bad, SUM(CASE WHEN outcome IS NULL THEN 1 ELSE 0 END) as pending FROM shadow_analysis_launches WHERE day = '${day}'`)[0] ?? {};
const launches = slots.n ?? 0;
const runs = d1(`SELECT COUNT(*) as n, SUM(CASE WHEN errors != '[]' THEN 1 ELSE 0 END) as errored FROM shadow_cron_runs WHERE started_at >= '${since}'`)[0] ?? {};
const preds = d1(`SELECT repository, COUNT(*) as n, SUM(CASE WHEN plan_mode='SELECTIVE' THEN 1 ELSE 0 END) as selective FROM shadow_predictions WHERE created_at >= '${since}' GROUP BY repository`);
const live = d1(`SELECT repository, last_head_check_at, last_head_changed_at, last_poll_success_at, consecutive_head_check_errors, consecutive_poll_errors FROM shadow_repositories WHERE repository IN ('vitest-dev/vitest','unjs/nitro')`);
const econ = d1(`SELECT repository, COUNT(*) as rows, SUM(CASE WHEN stage='test' THEN full_workload_ms ELSE 0 END) as test_ms, SUM(full_workload_ms) as total_ms, SUM(CASE WHEN avoidable_tier='ESTIMATED' THEN avoidable_ms ELSE 0 END) as est_avoidable FROM shadow_economics_observations WHERE repository IN ('vitest-dev/vitest','unjs/nitro') GROUP BY repository`);

console.log(`=== LOAD GATE @ ${new Date().toISOString()} ===`);
console.log(`launch slots consumed today: ${launches} / 60  ${launches > 60 ? "*** CEILING BREACHED ***" : "ok"}`);
console.log(`  succeeded=${slots.ok ?? 0} failed=${slots.bad ?? 0} pending=${slots.pending ?? 0}   (every launch spends a slot regardless of outcome)`);
const tr = d1(`SELECT COUNT(*) as n, SUM(CASE WHEN analysed=1 THEN 1 ELSE 0 END) as analysed FROM shadow_head_transitions`)[0] ?? {};
console.log(`head transitions recorded: ${tr.n ?? 0} (analysed ${tr.analysed ?? 0}, deferred ${(tr.n ?? 0) - (tr.analysed ?? 0)})`);
console.log(`cron runs today: ${runs.n ?? 0}, runs with errors: ${runs.errored ?? 0}`);
console.log(`--- predictions today ---`);
for (const p of preds) console.log(`  ${p.repository.padEnd(20)} ${p.n} predictions (${p.selective} SELECTIVE)`);
if (!preds.length) console.log("  (none yet)");
console.log(`--- liveness ---`);
for (const l of live) console.log(`  ${l.repository.padEnd(20)} headCheck=${l.last_head_check_at ?? "never"} changed=${l.last_head_changed_at ?? "-"} pollOk=${l.last_poll_success_at ?? "-"} errs=${l.consecutive_head_check_errors}/${l.consecutive_poll_errors}`);
console.log(`--- economics ---`);
for (const e of econ) {
  const frac = e.total_ms ? ((e.test_ms / e.total_ms) * 100).toFixed(1) : "0.0";
  console.log(`  ${e.repository.padEnd(20)} rows=${e.rows} classified=${frac}% estAvoidable=${(e.est_avoidable/1000).toFixed(1)}s`);
}
if (!econ.length) console.log("  (no economics rows yet)");
