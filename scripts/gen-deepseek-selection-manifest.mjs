// One-off generator (2026-08-23): build the deepseek-harness blind-baseline selection
// manifest from the replay JSONL + resolved first-parent bases. Mirrors the frozen
// scripts/diffci-blind-baseline.ts `select()` output shape exactly, with the base SHAs
// resolved from the cloned repo (git rev-parse <head>^1) instead of a live `gh` PR walk.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const GIT_DIR = process.env.DSH_GIT_DIR;
const REPLAY = process.env.DSH_REPLAY;
const OUT = process.env.DSH_OUT;

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const git = (args) =>
  execFileSync("git", ["--git-dir", GIT_DIR, ...args], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 }).trim();

const rows = readFileSync(REPLAY, "utf8")
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const merges = rows.map((r, i) => {
  const baseSha = git(["rev-parse", `${r.head}^1`]);
  const mergeTimestamp = git(["log", "-1", "--format=%cI", r.head]);
  const committerUnix = Number(git(["log", "-1", "--format=%ct", r.head]));
  const prMergedAt = new Date(committerUnix * 1000).toISOString();
  const m = /^Merge pull request #(\d+)/.exec(r.subject);
  const prNumber = m ? Number(m[1]) : null;
  return {
    index: i + 1,
    prNumber,
    mergeSha: r.head,
    baseSha,
    mergeTimestamp,
    subject: r.subject,
    changedFiles: r.changedFiles,
    mergeKind: "merge-commit",
    prVerified: "verified",
    prMergedAt,
    prMergeCommitSha: r.head,
  };
});

const manifest = {
  repository: "deepseek-ai/deepseek-harness",
  resolvedRepository: "deepseek-ai/deepseek-harness",
  url: "https://github.com/deepseek-ai/deepseek-harness",
  defaultBranch: "master",
  cutoff: "2026-08-23T00:00:00Z",
  selectionRule:
    "first-parent of default branch, newest first, committer date <= cutoff; PR merge commits ('Merge pull request #N') or squash/rebase commits ('... (#N)'); PR merged-state verified via GitHub API when available; not-merged PRs excluded; nothing cherry-picked or replaced",
  requested: 30,
  selected: merges.length,
  scannedFirstParentCommits: merges.length,
  generatedAt: new Date().toISOString(),
  merges,
  mergeListSha256: sha256(merges.map((m) => `${m.baseSha}..${m.mergeSha}`).join("\n")),
};

writeFileSync(OUT, JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({
  repo: manifest.resolvedRepository,
  selected: manifest.selected,
  checksum: manifest.mergeListSha256,
  verified: merges.filter((m) => m.prVerified === "verified").length,
}));