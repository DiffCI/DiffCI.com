/**
 * Blind multi-repository baseline driver (2026-08-23). HARNESS ONLY - never touches analysis,
 * classification, graph construction, test discovery or verdicts; it shells out to the frozen
 * `scripts/diffci-benchmark-external.ts` exactly as the deepseek benchmark did.
 *
 *   npx tsx scripts/diffci-blind-baseline.ts select --repo <owner/name> --clone <dir> --cutoff <ISO> --count 30 --manifest <out.json>
 *   npx tsx scripts/diffci-blind-baseline.ts replay --clone <dir> --manifest <in.json> --out <rows.jsonl> [--log <file>]
 *
 * Selection: default branch, first-parent history, newest-first, commits authored <= cutoff, keep
 * commits that are PR merges (a real merge commit "Merge pull request #N" OR a squash/rebase commit
 * whose subject ends "(#N)"), verify each PR number through the GitHub API (merged, and the PR's
 * merge_commit_sha equals this commit) when `gh` is available; unverifiable rows are KEPT but flagged,
 * never silently swapped. base = first parent (resolved to a full SHA here, so no `~`/`^` ever reaches a
 * shell). Once written, the manifest carries a SHA-256 of its merge list; replay refuses a manifest
 * whose checksum no longer matches.
 */
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recoverStaleGitLock } from "../src/analysis-fanout/git-lock.js";

const argv = process.argv.slice(2);
const mode = argv[0];
const get = (k: string, d?: string) => { const i = argv.indexOf(k); return i === -1 ? d : argv[i + 1]; };
const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 }).trim();
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

interface MergeRow { index: number; prNumber: number | null; mergeSha: string; baseSha: string; mergeTimestamp: string; subject: string; changedFiles: number; mergeKind: "merge-commit" | "squash-or-rebase"; prVerified: "verified" | "mismatch" | "unverified" | "not-merged"; prMergedAt?: string; prMergeCommitSha?: string; }

function cloneIfNeeded(repo: string, dir: string): void {
  if (existsSync(join(dir, ".git"))) { git(["fetch", "--quiet", "origin"], dir); return; }
  mkdirSync(resolve(dir, ".."), { recursive: true });
  // blob-less partial clone: full history/trees for selection, blobs fetched on checkout only
  execFileSync("git", ["clone", "--quiet", "--filter=blob:none", `https://github.com/${repo}.git`, dir], { stdio: "inherit" });
}

function select(): void {
  const repo = get("--repo")!; const dir = resolve(get("--clone")!); const cutoff = get("--cutoff")!; const count = Number(get("--count", "30")); const out = resolve(get("--manifest")!);
  cloneIfNeeded(repo, dir);
  const defaultBranch = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], dir).replace(/^origin\//, "");
  const resolvedName = (() => { try { return JSON.parse(execFileSync("gh", ["api", `repos/${repo}`], { encoding: "utf8" })).full_name as string; } catch { return repo; } })();
  const lines = git(["log", `origin/${defaultBranch}`, "--first-parent", `--before=${cutoff}`, "--format=%H%x1f%P%x1f%cI%x1f%s", "-n", "600"], dir).split("\n").filter(Boolean);
  const rows: MergeRow[] = []; let scanned = 0;
  for (const line of lines) {
    if (rows.length >= count) break;
    scanned++;
    const [sha, parents, when, subject] = line.split("\x1f") as [string, string, string, string];
    const parentList = parents.split(" ").filter(Boolean);
    let prNumber: number | null = null; let mergeKind: MergeRow["mergeKind"];
    const m1 = /^Merge pull request #(\d+)/.exec(subject); const m2 = /\(#(\d+)\)\s*$/.exec(subject);
    if (parentList.length >= 2 && m1) { prNumber = Number(m1[1]); mergeKind = "merge-commit"; }
    else if (parentList.length === 1 && m2) { prNumber = Number(m2[1]); mergeKind = "squash-or-rebase"; }
    else continue; // direct push / non-PR commit: excluded (verifiable from subject+parents)
    const baseSha = parentList[0]!;
    let prVerified: MergeRow["prVerified"] = "unverified"; let prMergedAt: string | undefined; let prMergeCommitSha: string | undefined;
    try {
      const pr = JSON.parse(execFileSync("gh", ["api", `repos/${resolvedName}/pulls/${prNumber}`], { encoding: "utf8" }));
      prMergedAt = pr.merged_at ?? undefined; prMergeCommitSha = pr.merge_commit_sha ?? undefined;
      prVerified = !pr.merged_at ? "not-merged" : pr.merge_commit_sha === sha ? "verified" : "mismatch";
    } catch { prVerified = "unverified"; }
    if (prVerified === "not-merged") continue; // verifiably not a merged PR
    const changedFiles = git(["diff", "--name-only", baseSha, sha], dir).split("\n").filter(Boolean).length;
    rows.push({ index: rows.length + 1, prNumber, mergeSha: sha, baseSha, mergeTimestamp: when, subject, changedFiles, mergeKind, prVerified, prMergedAt, prMergeCommitSha });
  }
  const manifest = { repository: repo, resolvedRepository: resolvedName, url: `https://github.com/${resolvedName}`, defaultBranch, cutoff, selectionRule: "first-parent of default branch, newest first, committer date <= cutoff; PR merge commits ('Merge pull request #N') or squash/rebase commits ('... (#N)'); PR merged-state verified via GitHub API when available; not-merged PRs excluded; nothing cherry-picked or replaced", requested: count, selected: rows.length, scannedFirstParentCommits: scanned, generatedAt: new Date().toISOString(), merges: rows, mergeListSha256: sha256(rows.map((r) => `${r.baseSha}..${r.mergeSha}`).join("\n")) };
  mkdirSync(resolve(out, ".."), { recursive: true });
  writeFileSync(out, JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ repo: resolvedName, defaultBranch, selected: rows.length, scanned, checksum: manifest.mergeListSha256, verified: rows.filter((r) => r.prVerified === "verified").length, mismatch: rows.filter((r) => r.prVerified === "mismatch").length, unverified: rows.filter((r) => r.prVerified === "unverified").length }));
}

function replay(): void {
  const dir = resolve(get("--clone")!); const manifestPath = resolve(get("--manifest")!); const out = resolve(get("--out")!); const log = get("--log");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const expect = sha256((manifest.merges as MergeRow[]).map((r) => `${r.baseSha}..${r.mergeSha}`).join("\n"));
  if (expect !== manifest.mergeListSha256) throw new Error(`manifest checksum mismatch: ${expect} != ${manifest.mergeListSha256} - manifest is immutable once analysis begins`);
  const done = new Set(existsSync(out) ? readFileSync(out, "utf8").trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l).mergeSha) : []);
  const P = resolve(__dirname_safe(), "..");
  for (const m of manifest.merges as MergeRow[]) {
    if (done.has(m.mergeSha)) continue;
    const t0 = Date.now();
    let checkout: { ok: boolean; error?: string } = { ok: true };
    // P1 harness isolation: a stale .git/index.lock left by a crashed/aborted earlier git process
    // (the cal.com "git-lock race") must not poison this merge's checkout. Recover it first; the
    // checkout below surfaces a real error if the lock is genuinely held by a live process.
    try { recoverStaleGitLock(dir); } catch { /* best-effort */ }
    try { git(["checkout", "--quiet", "--force", "--detach", m.mergeSha], dir); } catch (e) { checkout = { ok: false, error: String(e).slice(0, 500) }; }
    let row: any;
    if (!checkout.ok) row = { ok: false, errorClass: "checkout-failure", error: checkout.error };
    else {
      // full SHAs only - never `~1`/`^1` through a shell (the 2026-08-23 cmd.exe `^` incident)
      const r = spawnSync(process.execPath, [join(P, "node_modules", "tsx", "dist", "cli.mjs"), join(P, "scripts", "diffci-benchmark-external.ts"), "--repo", dir, "--base", m.baseSha, "--head", m.mergeSha], { cwd: P, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, timeout: 30 * 60_000 });
      const stdout = (r.stdout ?? "").trim(); const first = stdout.indexOf("{"); const last = first === -1 ? undefined : stdout.slice(first);
      if (r.error && /ETIMEDOUT/.test(String(r.error))) row = { ok: false, errorClass: "timeout", error: "benchmark exceeded 30 min" };
      else if (r.status !== 0 && !last) row = { ok: false, errorClass: r.signal ? `signal:${r.signal}` : `exit:${r.status}`, error: (r.error ? String(r.error) + " | " : "") + (r.stderr ?? "").slice(-1500) };
      else { try { row = JSON.parse(last!); } catch { row = { ok: false, errorClass: "unparseable-output", error: stdout.slice(-800) }; } }
      if (row.ok && (row.resolvedBaseSha !== m.baseSha || row.resolvedHeadSha !== m.mergeSha)) row = { ok: false, errorClass: "base-head-mismatch", error: `engine resolved ${row.resolvedBaseSha}..${row.resolvedHeadSha}` };
    }
    const rec = { repository: manifest.resolvedRepository ?? manifest.repository, prNumber: m.prNumber, mergeSha: m.mergeSha, baseSha: m.baseSha, mergeTimestamp: m.mergeTimestamp, subject: m.subject, manifestChangedFiles: m.changedFiles, harnessWallMs: Date.now() - t0, ...row };
    appendFileSync(out, JSON.stringify(rec) + "\n");
    const line = `${m.index}/${manifest.merges.length} #${m.prNumber} ${rec.ok ? rec.analysisStatus : "ERR:" + rec.errorClass} ${rec.ok ? rec.affectedTests + "/" + rec.totalTestsInGraph : ""} ${Math.round(rec.harnessWallMs / 1000)}s`;
    console.log(line); if (log) appendFileSync(log, line + "\n");
  }
}

function __dirname_safe(): string { return dirname(fileURLToPath(import.meta.url)); }

if (mode === "select") select(); else if (mode === "replay") replay(); else { console.error("mode: select | replay"); process.exit(1); }
