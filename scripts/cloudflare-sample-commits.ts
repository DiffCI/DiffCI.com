/**
 * Phase 1 of the resumable Cloudflare medium-batch pipeline: clone/update a repository and
 * deterministically sample up to N commits, WITHOUT analyzing any of them. Outputs the candidate delta
 * list (with each candidate's logicalDeltaKey already computed) so the calling Worker can check D1 for
 * already-completed work BEFORE dispatching any real analysis - see
 * src/research/cloudflare/resumable-batch.ts for the resumability design this feeds.
 *
 * Usage: npx tsx scripts/cloudflare-sample-commits.ts --owner <o> --name <n> --language <lang>
 *        --max-commits <n> --workspace <path> [--out <path>]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { cloneOrUpdateRepo } from "../src/research/repository/collector.js";
import { sampleCommits } from "../src/research/repository/sampler.js";
import { DIFFCI_VERSION, SCHEMA_VERSION } from "../src/research/config/stage0.js";
import type { ResearchRepository } from "../src/research/types.js";

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
  const maxCommits = Number.parseInt(args["max-commits"] ?? "50", 10);
  const workspace = resolve(args.workspace ?? "/workspace");
  const outPath = resolve(args.out ?? `${workspace}/candidates.json`);

  if (!owner || !name) {
    console.error("Usage: --owner <owner> --name <name> [--language <lang>] [--max-commits <n>] [--workspace <path>] [--out <path>]");
    process.exit(1);
  }

  mkdirSync(workspace, { recursive: true });
  const repoCacheDir = `${workspace}/repos`;
  mkdirSync(repoCacheDir, { recursive: true });

  const repo: ResearchRepository = { owner, name, primaryLanguage, framework: "unknown", sizeClass: "medium" };
  const metadata = cloneOrUpdateRepo(repo, repoCacheDir, 300);

  const output: {
    owner: string;
    name: string;
    metadata: typeof metadata;
    candidates: { baseSha: string; headSha: string; logicalDeltaKey: string }[];
  } = { owner, name, metadata, candidates: [] };

  if (!metadata.exclusionReason) {
    const commits = sampleCommits(metadata, {
      maxCommits,
      recentCommitWindow: Math.max(maxCommits * 4, 200),
      excludeMergeCommits: true,
      excludeBotCommits: true,
    });
    output.candidates = commits.map((c) => ({
      baseSha: c.baseSha,
      headSha: c.headSha,
      logicalDeltaKey: `${owner}/${name}:${c.baseSha}:${c.headSha}:${DIFFCI_VERSION}:${SCHEMA_VERSION}`,
    }));
  }

  writeFileSync(outPath, JSON.stringify(output, null, 2), "utf8");
  console.log(JSON.stringify({ ok: true, outPath, excluded: !!metadata.exclusionReason, candidateCount: output.candidates.length }));
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
