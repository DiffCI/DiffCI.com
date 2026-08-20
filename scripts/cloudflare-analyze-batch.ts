/**
 * Phase 2 of the resumable Cloudflare medium-batch pipeline: given a repository (already cloned by
 * phase 1 in the same container session) and a SPECIFIC batch of {baseSha, headSha} pairs the Worker
 * has already confirmed are not yet complete (via D1), run the real analysis on exactly that batch and
 * return the resulting BenchmarkRecords. Reuses runRepoBenchmark() unmodified via its `commits` option
 * (see runner.ts) - no re-sampling, no re-deciding what to analyze.
 *
 * Usage: npx tsx scripts/cloudflare-analyze-batch.ts --owner <o> --name <n> --language <lang>
 *        --workspace <path> --batch-file <path-to-json-array-of-{baseSha,headSha}> [--out <path>]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runRepoBenchmark } from "../src/research/benchmark/runner.js";
import { LocalEvidenceStore } from "../src/research/store/evidence.js";
import { DIFFCI_VERSION, SCHEMA_VERSION } from "../src/research/config/stage0.js";
import type { ResearchRepository } from "../src/research/types.js";
import { createRateBudget, DEFAULT_AUTHENTICATED_CALLS_PER_HOUR, DEFAULT_UNAUTHENTICATED_CALLS_PER_HOUR } from "../src/research/historical/rate-budget.js";

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith("--")) args[arg.slice(2)] = argv[++i] ?? "";
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const owner = args.owner;
  const name = args.name;
  const primaryLanguage = args.language ?? "typescript";
  const workspace = resolve(args.workspace ?? "/workspace");
  const batchFile = resolve(args["batch-file"] ?? "");
  const outPath = resolve(args.out ?? `${workspace}/batch-result.json`);

  if (!owner || !name || !batchFile || !existsSync(batchFile)) {
    console.error("Usage: --owner <owner> --name <name> [--language <lang>] --batch-file <path> --workspace <path> [--out <path>]");
    process.exit(1);
  }

  const batch = JSON.parse(readFileSync(batchFile, "utf8")) as { baseSha: string; headSha: string }[];

  // Historical CI evidence collection (src/research/historical/evidence-collector.ts) is opt-in and off
  // unless a token is present. The token is passed as an env var (never a CLI arg, so it never appears
  // in the exec command string the Worker logs on failure - see errorTail() in validation-worker.ts) by
  // the Worker forwarding its GITHUB_TOKEN secret into sandbox.exec()'s per-invocation `env` option.
  // Budget is scoped to THIS process only (one batch of up to 25 deltas) - it does not accumulate
  // across batches, but 25 deltas x ~3 calls each is far under even the unauthenticated 50/hour budget,
  // so this granularity has no practical effect on pacing correctness.
  const githubToken = process.env.GITHUB_TOKEN || undefined;
  const collectHistoricalEvidence = Boolean(githubToken);
  const historicalRateBudget = collectHistoricalEvidence
    ? createRateBudget(githubToken ? DEFAULT_AUTHENTICATED_CALLS_PER_HOUR : DEFAULT_UNAUTHENTICATED_CALLS_PER_HOUR)
    : undefined;
  // Stage 1B (2026-08-21): same env-var-not-CLI-arg pattern as GITHUB_TOKEN above. Off unless both a
  // token is present AND explicitly requested - flakiness checking spends extra GitHub API calls per
  // candidate miss, so it should never turn on silently just because a token happens to be configured.
  const checkHistoricalFlakiness = collectHistoricalEvidence && process.env.CHECK_FLAKINESS === "1";

  mkdirSync(workspace, { recursive: true });
  const repoCacheDir = `${workspace}/repos`;
  const graphCacheDir = `${workspace}/cache/graphs`;
  // A per-batch-call evidence store scoped to just this call - it is a scratch/dedup layer for
  // runRepoBenchmark's own internal resumability check, not the source of truth for cross-container
  // resumability (that decision already happened in the Worker, via D1, before this batch was chosen -
  // see resumable-batch.ts). Every commit in `batch` is expected to be genuinely new work.
  const evidenceDir = `${workspace}/batch-evidence-${Date.now()}`;
  mkdirSync(repoCacheDir, { recursive: true });
  mkdirSync(graphCacheDir, { recursive: true });

  const repo: ResearchRepository = { owner, name, primaryLanguage, framework: "unknown", sizeClass: "medium" };
  const store = new LocalEvidenceStore(evidenceDir);

  const config = {
    experimentId: `stage0-medium-batch-${owner}-${name}`,
    diffciVersion: DIFFCI_VERSION,
    schemaVersion: SCHEMA_VERSION,
    repoCacheDir,
    cacheDir: graphCacheDir,
    cloneDepth: 300,
    maxCommitsPerRepository: batch.length,
    recentCommitWindow: 200,
    excludeMergeCommits: true,
    excludeBotCommits: true,
    graphTimeouts: { smallMs: 60_000, mediumMs: 180_000, largeMs: 300_000 },
    collectHistoricalEvidence,
    githubToken,
    historicalRateBudget,
    checkHistoricalFlakiness,
  };

  const startedAt = Date.now();
  const bench = await runRepoBenchmark({ repo, store, config, dryRun: false, commits: batch });
  const durationMs = Date.now() - startedAt;

  writeFileSync(
    outPath,
    JSON.stringify({ owner, name, durationMs, batchSize: batch.length, records: bench.records, errors: bench.errors }, null, 2),
    "utf8",
  );
  console.log(
    JSON.stringify({ ok: true, outPath, recordsAnalyzed: bench.records.length, errors: bench.errors.length, durationMs, collectHistoricalEvidence }),
  );
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
