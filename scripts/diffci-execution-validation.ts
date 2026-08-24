/**
 * Execution validation (2026-08-23, deepseek-harness Phase 6): for each merge DiffCI authorized,
 * really run the repository's own CI test commands - full suite and DiffCI-selected subset - in an
 * isolated git worktree at the merge HEAD, and record correctness + timing. Families that need
 * credentials/browsers (e2e: DEEPSEEK_API_KEY; web: built bundles + Playwright) are recorded as
 * UNEXECUTED, never faked. Usage:
 *   npx tsx scripts/diffci-execution-validation.ts --repo <clone> --worktrees <dir> --replay <jsonl> --out <jsonl> [--only sha,sha] [--parent-check]
 *
 * `--parent-check` additionally runs the SELECTED tests (taken from merge HEAD) against the pre-merge
 * parent tree (merge~1 with HEAD's selected test files overlaid) - the "would the selection have
 * caught this PR's behaviour change?" reconstruction.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, appendFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { analyzeGitDelta } from "../src/git/git-diff.js";
import { buildDependencyGraph } from "../src/repo/graph.js";
import { ImpactAnalyzer } from "../src/repo/impact.js";
import { testFamilyOfPath } from "../src/repo/test-discovery.js";

const EXCLUDE_DIRS = ["node_modules", ".next", "dist", "build", ".git"];
const args = process.argv.slice(2);
const get = (k: string) => { const i = args.indexOf(k); return i === -1 ? undefined : args[i + 1]; };
const REPO = resolve(get("--repo")!); const WT = resolve(get("--worktrees")!); const REPLAY = resolve(get("--replay")!); const OUT = resolve(get("--out")!);
const ONLY = get("--only")?.split(",").filter(Boolean); const PARENT_CHECK = args.includes("--parent-check");
mkdirSync(WT, { recursive: true });
const isWin = process.platform === "win32";
const PNPM = isWin ? "corepack.cmd" : "corepack";

function sh(cmd: string, cmdArgs: string[], cwd: string, timeoutMs: number, env: Record<string, string> = {}) {
  const t0 = Date.now();
  const r = spawnSync(cmd, cmdArgs, { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 512 * 1024 * 1024, shell: isWin, env: { ...process.env, CI: "1", FORCE_COLOR: "0", ...env } });
  return { status: r.status, signal: r.signal, timedOut: !!r.error && /ETIMEDOUT/.test(String(r.error)), wallMs: Date.now() - t0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
function git(cmdArgs: string[], cwd = REPO): string { return execFileSync("git", cmdArgs, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).trim(); }

interface VitestSummary { files: number; filesFailed: number; tests: number; failed: number; passed: number; skipped: number; failedTests: string[]; parsed: boolean; }
function parseVitestJson(path: string): VitestSummary {
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    const failedTests: string[] = [];
    for (const f of j.testResults ?? []) for (const a of f.assertionResults ?? []) if (a.status === "failed") failedTests.push(`${f.name.replace(/\\/g, "/").split("/").slice(-3).join("/")} :: ${a.fullName}`);
    return { files: j.numTotalTestSuites ?? 0, filesFailed: j.numFailedTestSuites ?? 0, tests: j.numTotalTests ?? 0, failed: j.numFailedTests ?? 0, passed: j.numPassedTests ?? 0, skipped: (j.numPendingTests ?? 0) + (j.numTodoTests ?? 0), failedTests, parsed: true };
  } catch { return { files: 0, filesFailed: 0, tests: 0, failed: 0, passed: 0, skipped: 0, failedTests: [], parsed: false }; }
}

function runVitest(cwd: string, config: string | undefined, files: string[] | undefined, label: string, timeoutMs: number) {
  const report = join(cwd, `.diffci-${label}.json`);
  const a = ["pnpm", "exec", "vitest", "run", "--reporter=default", "--reporter=json", `--outputFile=${report}`];
  if (config) a.push("--config", config);
  if (files) a.push(...files);
  const r = sh(PNPM, a, cwd, timeoutMs);
  const summary = parseVitestJson(report);
  return { ...summary, exitCode: r.status, signal: r.signal, timedOut: r.timedOut, wallMs: r.wallMs, stderrTail: r.stderr.slice(-1500), stdoutTail: r.stdout.slice(-1500) };
}

const replay = readFileSync(REPLAY, "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l));
const authorized = replay.filter((r) => r.ok && !r.fallbackRequired);
const done = new Set(existsSync(OUT) ? readFileSync(OUT, "utf8").trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l).sha) : []);
const fullShaOf = (short: string) => git(["rev-parse", short]);

for (const m of authorized) {
  if (ONLY && !ONLY.some((s) => m.sha.startsWith(s))) continue;
  if (done.has(m.sha)) continue;
  const head = fullShaOf(m.sha);
  const wt = join(WT, m.sha);
  const rec: any = { sha: m.sha, head, subject: m.subject, platform: `${process.platform}/${process.arch} node ${process.version}`, startedAt: new Date().toISOString(), steps: {} };
  try {
    if (existsSync(wt)) { try { git(["worktree", "remove", "--force", wt]); } catch { rmSync(wt, { recursive: true, force: true }); } }
    let t = Date.now(); git(["worktree", "add", "--detach", wt, head]); rec.steps.worktreeMs = Date.now() - t;

    // 1. DiffCI analysis at HEAD (timed as the overhead that must be charged against savings)
    t = Date.now();
    const g = await analyzeGitDelta({ repoPath: wt, baseSha: `${head}~1`, headSha: head });
    if (!g.success) throw new Error(g.error);
    const graph = await buildDependencyGraph({ repoPath: wt, excludeDirs: EXCLUDE_DIRS });
    const impact = new ImpactAnalyzer().analyze(g.delta, graph, graph.profile, { repositoryFiles: g.inventory?.files });
    rec.steps.diffciAnalysisMs = Date.now() - t;
    rec.diffci = { analysisStatus: impact.analysisStatus, affectedTests: impact.affectedTests.length, totalTests: graph.graph.nodes.filter((n) => n.isTest).length };
    if (impact.fallbackRequired) { rec.outcome = "not-authorized-at-execution-time"; appendFileSync(OUT, JSON.stringify(rec) + "\n"); continue; }
    const selected = impact.affectedTests.map((x) => x.path);
    const byFamily = (paths: string[]) => { const o: Record<string, string[]> = {}; for (const p of paths) (o[testFamilyOfPath(p) ?? "untagged"] ??= []).push(p); return o; };
    const selFam = byFamily(selected); const totFam = byFamily(graph.graph.nodes.filter((n) => n.isTest).map((n) => n.path));
    rec.selectedByFamily = Object.fromEntries(Object.entries(selFam).map(([k, v]) => [k, v.length]));
    rec.totalByFamily = Object.fromEntries(Object.entries(totFam).map(([k, v]) => [k, v.length]));
    rec.selectedFiles = selected;

    // 2. exact locked install (separate timing; --ignore-scripts: no lifecycle scripts, matches the R2 policy)
    const pkg = JSON.parse(readFileSync(join(wt, "package.json"), "utf8"));
    rec.packageManager = pkg.packageManager;
    const inst = sh(PNPM, ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"], wt, 30 * 60_000, { COREPACK_ENABLE_STRICT: "0" });
    rec.steps.install = { exitCode: inst.status, wallMs: inst.wallMs, timedOut: inst.timedOut, stderrTail: inst.stderr.slice(-800) };
    if (inst.status !== 0) { rec.outcome = "environment-failure:install"; appendFileSync(OUT, JSON.stringify(rec) + "\n"); continue; }

    // 3. families: unit = `vitest run` (pnpm test); snapshot = vitest.snapshot.config.ts (replay, keyless); e2e/web = unexecuted
    rec.families = {};
    const unitFull = runVitest(wt, undefined, undefined, "unit-full", 60 * 60_000);
    rec.families.unit = { command: "pnpm exec vitest run", full: unitFull };
    const unitSel = selFam.unit ?? [];
    rec.families.unit.selected = unitSel.length > 0 ? runVitest(wt, undefined, unitSel, "unit-selected", 60 * 60_000) : { skipped: "no unit tests selected", wallMs: 0, failed: 0, failedTests: [], tests: 0, files: 0 };
    if (existsSync(join(wt, "vitest.snapshot.config.ts"))) {
      const snapFull = runVitest(wt, "vitest.snapshot.config.ts", undefined, "snap-full", 60 * 60_000);
      rec.families.snapshot = { command: "pnpm exec vitest run --config vitest.snapshot.config.ts", full: snapFull };
      const snapSel = selFam.snapshot ?? [];
      rec.families.snapshot.selected = snapSel.length > 0 ? runVitest(wt, "vitest.snapshot.config.ts", snapSel, "snap-selected", 60 * 60_000) : { skipped: "no snapshot tests selected", wallMs: 0, failed: 0, failedTests: [], tests: 0, files: 0 };
    }
    rec.families.e2e = { unexecuted: "requires DEEPSEEK_API_KEY (workflow e2e.yml) - external credential not available", selectedCount: (selFam.e2e ?? []).length, totalCount: (totFam.e2e ?? []).length };
    rec.families.web = { unexecuted: "apps/web tests need built client bundles + Playwright Chromium (ci-consumers gate)", selectedCount: selected.filter((p) => p.startsWith("apps/web/")).length };

    // 4. optional pre-merge reconstruction: selected tests from HEAD run against merge~1 + HEAD's test files
    if (PARENT_CHECK && unitSel.length > 0) {
      const parent = git(["rev-parse", `${head}~1`], wt);
      git(["checkout", "--detach", "-q", parent], wt);
      const existingSel = unitSel.filter((p) => git(["ls-tree", "--name-only", head, "--", p], wt) === p);
      if (existingSel.length > 0) git(["checkout", head, "--", ...existingSel], wt);
      const parentRun = runVitest(wt, undefined, existingSel, "unit-selected-on-parent", 60 * 60_000);
      rec.parentReconstruction = { parent, selectedTestsApplied: existingSel.length, run: parentRun };
      git(["checkout", "-q", "--", "."], wt); git(["checkout", "--detach", "-q", head], wt);
    }

    // 5. economics (unit + snapshot families that were actually executed)
    const fullMs = (rec.families.unit.full.wallMs ?? 0) + (rec.families.snapshot?.full.wallMs ?? 0);
    const selMs = (rec.families.unit.selected.wallMs ?? 0) + (rec.families.snapshot?.selected.wallMs ?? 0);
    rec.economics = { fullTestMs: fullMs, selectedTestMs: selMs, diffciAnalysisMs: rec.steps.diffciAnalysisMs, installMs: inst.wallMs, grossSavedMs: fullMs - selMs, netSavedMs: fullMs - selMs - rec.steps.diffciAnalysisMs, reductionPct: fullMs > 0 ? ((fullMs - selMs - rec.steps.diffciAnalysisMs) / fullMs) * 100 : null };
    const fullFailed = [...(rec.families.unit.full.failedTests ?? []), ...(rec.families.snapshot?.full.failedTests ?? [])];
    const selFailed = [...(rec.families.unit.selected.failedTests ?? []), ...(rec.families.snapshot?.selected.failedTests ?? [])];
    rec.agreement = { fullFailures: fullFailed.length, selectedFailures: selFailed.length, fullFailuresMissedBySelection: fullFailed.filter((f) => !selFailed.includes(f)), selectedOnlyFailures: selFailed.filter((f) => !fullFailed.includes(f)) };
    rec.outcome = "executed";
  } catch (e) {
    rec.outcome = "environment-failure:exception"; rec.error = String(e).slice(0, 2000);
  } finally {
    rec.finishedAt = new Date().toISOString();
    appendFileSync(OUT, JSON.stringify(rec) + "\n");
    try { git(["worktree", "remove", "--force", wt]); } catch { /* keep for inspection */ }
  }
  console.log(m.sha, rec.outcome, JSON.stringify(rec.economics ?? {}), JSON.stringify(rec.agreement ?? {}));
}
writeFileSync(join(WT, "DONE"), new Date().toISOString());
