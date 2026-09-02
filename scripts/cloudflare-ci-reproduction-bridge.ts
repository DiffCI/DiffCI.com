/**
 * EXTERNAL_ENGINE_BRIDGE_01 (2026-09-02) — the container-side half of the bridge:
 * `real Shadow push → existing repository identity → existing Sandbox → exact commit → ci:reproduce →
 * persisted reproduction result`. Modelled directly on cloudflare-shadow-poll.ts's shape (same argv
 * convention, same "clone, derive HEAD, write one result file" structure) but runs a SEPARATE, independent
 * engine - src/ci-inference/ via scripts/ci-reproduction.ts - not the dependency-graph predictor
 * cloudflare-shadow-poll.ts runs. Shadow stays the transport/orchestration layer; ci-inference stays
 * independent, per docs/external-engine-bridge-01-plan.md - this script does not import anything from
 * src/research/diffci/, src/repo/, or src/planner/, on purpose.
 *
 * WHAT THIS DOES NOT DO: it does not auto-generate a reference plan. ci-reproduction.ts's own graceful
 * refusal (added alongside this bridge) handles a repository with none - this script always invokes it
 * and reports back exactly what it decided, never substituting its own judgement.
 *
 * INJECTION SAFETY: `repository`/`headSha` are threaded into ci-reproduction.ts as individual argv
 * elements via `execFileSync`, never concatenated into a shell string - the same discipline
 * ci-reproduction.ts's OWN internal git/step invocations already use throughout. `headSha` is derived
 * from `git rev-parse HEAD` after an authenticated clone/fetch, never trusted from a caller-supplied
 * value - the caller only ever supplies `owner`/`name`, validated the same way cloudflare-shadow-poll.ts's
 * caller (validateShellSafeIdentifiers) already validates them before this script is even invoked.
 *
 * Usage: npx tsx scripts/cloudflare-ci-reproduction-bridge.ts --owner <o> --name <n> --workspace <path>
 *        --out <path>
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gitAuthEnv, runGit } from "../src/research/repository/collector.js";

const CLONE_DEPTH = 50; // generous margin over a single push's worth of history; ci:reproduce only ever needs HEAD

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith("--")) args[arg.slice(2)] = argv[++i] ?? "";
  }
  return args;
}

/** Mirrors validation-jobs.ts's isRepositorySlug/isPinnedSha exactly (character classes, not imported
 *  directly - this script deliberately has no dependency on src/validation-env/, a Cloudflare-DO-shaped
 *  module family this bridge does not otherwise touch). Defence in depth: owner/name are already
 *  validated by the Worker before this script runs, and headSha is derived from git itself, not from
 *  external input - but the values still cross into an argv array a subprocess reads, so they are
 *  checked here too rather than assumed safe because of where they came from. */
function isRepositorySlug(repository: string): boolean {
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repository);
}
function isPinnedSha(sha: string): boolean {
  return /^[0-9a-f]{40}$/.test(sha);
}

/** A plain authenticated clone/fetch, deliberately NOT collector.ts's cloneOrUpdateRepo - that function
 *  gates on TypeScript/JavaScript source (isKnownUnsupportedLanguage), a concern specific to the
 *  dependency-graph engine Shadow's own poll uses. ci:reproduce reasons about GitHub Actions workflow
 *  YAML, not source language, and must not inherit an exclusion rule that has nothing to do with it. */
function cloneAndResolveHead(repository: string, cacheDir: string): string {
  const localPath = resolve(cacheDir, repository.replace("/", "--"));
  mkdirSync(cacheDir, { recursive: true });
  const cloneUrl = `https://github.com/${repository}.git`;
  if (!existsSync(resolve(localPath, ".git"))) {
    const result = spawnSync(
      "git",
      ["clone", "--depth", String(CLONE_DEPTH), "--no-single-branch", cloneUrl, localPath],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: gitAuthEnv() },
    );
    if (result.status !== 0) {
      throw new Error(`clone failed: ${result.stderr?.trim() || result.stdout?.trim() || "unknown"}`);
    }
  } else {
    runGit(["fetch", "--depth", String(CLONE_DEPTH), "--force", "origin", "HEAD"], localPath);
    const defaultBranch = runGit(["rev-parse", "--abbrev-ref", "origin/HEAD"], localPath).replace("origin/", "").trim();
    if (defaultBranch) runGit(["reset", "--hard", `origin/${defaultBranch}`], localPath);
  }
  return runGit(["rev-parse", "HEAD"], localPath).trim();
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const owner = args.owner;
  const name = args.name;
  const workspace = resolve(args.workspace ?? "/workspace");
  const outPath = resolve(args.out ?? `${workspace}/ci-reproduction-bridge-result.json`);

  if (!owner || !name) {
    console.error("Usage: --owner <owner> --name <name> --workspace <path> --out <path>");
    process.exit(1);
  }
  const repository = `${owner}/${name}`;
  if (!isRepositorySlug(repository)) {
    writeFileSync(outPath, JSON.stringify({ ok: false, repository, error: `invalid repository slug: "${repository}"` }, null, 2));
    console.log(JSON.stringify({ ok: false, error: "invalid-repository-slug" }));
    return;
  }

  mkdirSync(workspace, { recursive: true });

  let headSha: string;
  try {
    headSha = cloneAndResolveHead(repository, `${workspace}/bridge-repos`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    writeFileSync(outPath, JSON.stringify({ ok: false, repository, error: `clone-or-fetch failed: ${message}` }, null, 2));
    console.log(JSON.stringify({ ok: false, error: "clone-failed" }));
    return;
  }
  if (!isPinnedSha(headSha)) {
    // Should be unreachable - `git rev-parse HEAD` always returns 40 lowercase hex, or the command
    // itself fails (already caught above). Checked anyway: this value is about to reach a subprocess's
    // argv, and "should be unreachable" is not the same claim as "verified".
    writeFileSync(outPath, JSON.stringify({ ok: false, repository, error: `git returned an unexpected HEAD value: "${headSha}"` }, null, 2));
    console.log(JSON.stringify({ ok: false, error: "invalid-head-sha" }));
    return;
  }

  // The reference plan naming convention validation-jobs.ts's JOBS registry already uses -
  // docs/evidence/ci-reproduction-05-<name>-reference-plan.json - kept identical rather than inventing a
  // second convention. `name` alone (not owner/name) matches every existing plan file; a same-named
  // repository under a different owner is a known, narrow limitation of this first bridge, not solved
  // here (see docs/external-engine-bridge-01-plan.md).
  const referencePlanPath = resolve(`docs/evidence/ci-reproduction-05-${name}-reference-plan.json`);
  const ciWorkDir = `${workspace}/ci-repro-work`;
  const ciOutDir = `${workspace}/ci-repro-out`;
  mkdirSync(ciOutDir, { recursive: true });

  try {
    // Pure argv, no shell - the SAME safety property ci-reproduction.ts's own internal git/step
    // invocations already have. `repository` and `headSha` are individual array elements; neither is
    // ever concatenated into a command string.
    execFileSync(
      "npx",
      ["tsx", "scripts/ci-reproduction.ts", "--repository", repository, "--head", headSha, "--work", ciWorkDir, "--out", ciOutDir, "--reference", referencePlanPath],
      { stdio: "pipe", timeout: 30 * 60_000 },
    );
  } catch (error: unknown) {
    // ci-reproduction.ts's own graceful-refusal fix (EXTERNAL_ENGINE_BRIDGE_01 step 1) means a missing
    // reference plan exits 0 with a REFUSED reproduction.json, not this branch. Reaching here means
    // something genuinely unexpected happened during a real attempt - reported honestly, not swallowed,
    // and not allowed to crash this bridge script uncaught either.
    const message = error instanceof Error ? error.message : String(error);
    writeFileSync(outPath, JSON.stringify({ ok: false, repository, headSha, error: `ci:reproduce invocation failed: ${message}` }, null, 2));
    console.log(JSON.stringify({ ok: false, repository, headSha, error: "ci-reproduce-failed" }));
    return;
  }

  const reproductionPath = `${ciOutDir}/reproduction.json`;
  if (!existsSync(reproductionPath)) {
    // ci-reproduction.ts exited 0 but wrote nothing - should not happen given its own contract, but
    // "should not happen" gets exactly the same honest handling as every other unexpected case here.
    writeFileSync(outPath, JSON.stringify({ ok: false, repository, headSha, error: "ci:reproduce exited cleanly but wrote no reproduction.json" }, null, 2));
    console.log(JSON.stringify({ ok: false, repository, headSha, error: "no-reproduction-json" }));
    return;
  }

  const reproduction = JSON.parse(readFileSync(reproductionPath, "utf8"));
  writeFileSync(outPath, JSON.stringify({ ok: true, repository, headSha, reproduction }, null, 2));
  console.log(JSON.stringify({ ok: true, repository, headSha, outcome: reproduction.outcome ?? reproduction.verdict }));
}

try {
  main();
} catch (error: unknown) {
  // A genuinely unanticipated failure outside every specific case already handled above. The Worker's
  // own caller (execCiReproductionBridge) treats a non-zero exit as a failure regardless, but printing
  // the reason here - rather than letting a bare stack trace be the only record - keeps this script's
  // own failure modes as legible as every other one it already handles explicitly.
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
}
