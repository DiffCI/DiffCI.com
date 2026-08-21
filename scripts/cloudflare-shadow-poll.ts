/**
 * Stage 2 Gate A (2026-08-21) - the Cloudflare-poll observation source. Clones/updates a real target
 * repository, checks its default branch's current HEAD against the last SHA this repository was polled
 * at, and for any commit(s) that landed since, computes a REAL DiffCI prediction via the same production
 * pipeline the rest of the research tooling uses (runDiffCIAnalysis) - deliberately NOT the deterministic
 * historical sampler (sampler.ts) used elsewhere, since Stage 2 needs actual chronological "what's new
 * since I last looked," not a representative historical sample.
 *
 * Deliberately does NOT fetch ground truth here - that's a separate reconciliation pass
 * (cloudflare-shadow-reconcile.ts), run later once the real commit's own CI has had time to complete.
 * Splitting these into two scripts/passes is what makes the prospectiveness proof
 * (predictionCreatedAt < groundTruth's own completion time) meaningful: the process that computes the
 * prediction literally cannot see the outcome yet, because reconciliation hasn't run.
 *
 * On a repository's FIRST-EVER poll (no lastSeenSha provided), this deliberately does NOT backfill
 * predictions for existing history - it only records the current HEAD as the new baseline. Predicting
 * against commits whose real CI outcome may already be known (because they're already in the past) would
 * not be prospective evidence, and silently mislabeling it as such is exactly what the Stage 2 spec's
 * "Research integrity" section forbids ("reconstructing a favorable decision afterward").
 *
 * Usage: npx tsx scripts/cloudflare-shadow-poll.ts --owner <o> --name <n> --language <lang>
 *        --workspace <path> [--last-seen-sha <sha>] [--diffci-version <v>] [--graph-version <v>]
 *        [--engine-source-sha <sha>] [--out <path>]
 *
 * --engine-source-sha (2026-08-21 source-integrity fix, src/research/cloudflare/shadow-source-integrity.ts):
 * the git commit SHA of the diffci source tree actually running THIS invocation of this very script -
 * stamped onto every prediction this run computes (RecordPredictionInput.engineSourceSha) so a prediction
 * can always be traced back to the exact implementation that produced it. validation-worker.ts's
 * executeShadowPoll always passes this (sourced from the verified R2 archive it just loaded) for the
 * cron/webhook autonomous paths; it's optional here because this script is also runnable standalone
 * (local debugging) where no such verified value exists - predictions from a run without it simply
 * record no engine SHA (NULL in D1), which is the honest answer, not a guess.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { cloneOrUpdateRepo } from "../src/research/repository/collector.js";
import { analyzeGitDelta } from "../src/git/git-diff.js";
import { runDiffCIAnalysis } from "../src/research/diffci/adapter.js";
import { buildGenericTaskRegistry } from "../src/research/baseline/registry.js";
import { parseRepositoryWorkflows } from "../src/research/baseline/workflow-parser.js";
import { analyzeRepository } from "../src/repo/analyzer.js";
import { runPathBaseline } from "../src/planner/path-baseline.js";
import { runGenericPathBaseline } from "../src/research/baseline/path-baseline.js";
import { classifyOpportunity } from "../src/research/benchmark/opportunity-analysis.js";
import { computeLogicalDeltaKey } from "../src/shadow/event-identity.js";
import type { CommitDelta } from "../src/research/types.js";
import type { ResearchRepository } from "../src/research/types.js";

const EXCLUDE_DIRS = ["node_modules", ".next", "dist", "build", "target", "coverage", ".cache"];
const MAX_NEW_COMMITS_PER_POLL = 10; // a burst-safety cap, not a silent-truncation one - see the output's truncatedNewCommitCount
const POLL_CLONE_DEPTH = 100; // see the call site's comment for why this isn't 0/"full"

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith("--")) args[arg.slice(2)] = argv[++i] ?? "";
  }
  return args;
}

function git(args: string[], cwd: string): string {
  return execSync(`git ${args.join(" ")}`, { cwd, encoding: "utf8" }).trim();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const owner = args.owner;
  const name = args.name;
  const primaryLanguage = args.language ?? "typescript";
  const workspace = resolve(args.workspace ?? "/workspace");
  const lastSeenSha = args["last-seen-sha"] || undefined;
  const diffciAnalysisVersion = args["diffci-version"] ?? "stage2-shadow-poll-1";
  const graphVersion = args["graph-version"] ?? "stage2-shadow-poll-1";
  const engineSourceSha = args["engine-source-sha"] || undefined;
  const outPath = resolve(args.out ?? `${workspace}/shadow-poll-result.json`);

  if (!owner || !name) {
    console.error("Usage: --owner <owner> --name <name> [--language <lang>] [--workspace <path>] [--last-seen-sha <sha>] [--out <path>]");
    process.exit(1);
  }

  mkdirSync(workspace, { recursive: true });
  const repoCacheDir = `${workspace}/repos`;
  mkdirSync(repoCacheDir, { recursive: true });

  // cloneOrUpdateRepo always passes depth literally to `git clone/fetch --depth` - 0 is rejected by git
  // ("depth 0 is not a positive number"), there is no "unlimited" sentinel. A bounded-but-generous depth
  // is the right choice for polling anyway (walking a genuinely full history on every poll would be slow
  // and wasteful): POLL_CLONE_DEPTH commits of margin is far more than any realistic gap between two
  // polls of an actively-polled repository. If lastSeenSha ever falls outside this window (a very long
  // gap between polls, or a burst of commits), the rev-list walk below fails safe - see the catch block.
  const repo: ResearchRepository = { owner, name, primaryLanguage, framework: "unknown", sizeClass: "medium" };
  // blobFilter:false - a full-blob shallow clone. The default blob:none partial clone broke private-
  // repo polling: analyzeGitDelta's git subprocesses trigger unauthenticated lazy blob fetches - see
  // cloneOrUpdateRepo's comment on the 2026-08-21 DiffCI.com self-shadow finding.
  const metadata = cloneOrUpdateRepo(repo, repoCacheDir, POLL_CLONE_DEPTH, { blobFilter: false });

  if (metadata.exclusionReason) {
    writeFileSync(outPath, JSON.stringify({ ok: false, owner, name, error: `clone-excluded: ${metadata.exclusionReason}` }), "utf8");
    console.log(JSON.stringify({ ok: false, error: "clone-excluded" }));
    return;
  }

  const repoPath = metadata.localPath;
  const currentHeadSha = git(["rev-parse", "HEAD"], repoPath);

  if (!lastSeenSha) {
    // First-ever poll: establish the baseline only, no predictions - see the doc comment above.
    writeFileSync(outPath, JSON.stringify({
      ok: true, owner, name, firstPoll: true, newHeadSha: currentHeadSha, predictions: [],
    }, null, 2), "utf8");
    console.log(JSON.stringify({ ok: true, firstPoll: true, newHeadSha: currentHeadSha, predictionsComputed: 0 }));
    return;
  }

  if (lastSeenSha === currentHeadSha) {
    writeFileSync(outPath, JSON.stringify({ ok: true, owner, name, firstPoll: false, newHeadSha: currentHeadSha, predictions: [], note: "no new commits" }, null, 2), "utf8");
    console.log(JSON.stringify({ ok: true, firstPoll: false, newHeadSha: currentHeadSha, predictionsComputed: 0 }));
    return;
  }

  // Oldest-first, so predictions are recorded in the order the real commits actually landed.
  let newShas: string[];
  try {
    newShas = git(["rev-list", "--reverse", `${lastSeenSha}..${currentHeadSha}`], repoPath).split("\n").filter(Boolean);
  } catch (error: unknown) {
    // lastSeenSha no longer reachable (force-push/history rewrite on the target's default branch) - fail
    // safe by re-baselining without predicting, rather than guessing at a commit range that may not
    // reflect what actually happened.
    writeFileSync(outPath, JSON.stringify({
      ok: true, owner, name, firstPoll: false, newHeadSha: currentHeadSha, predictions: [],
      note: `lastSeenSha unreachable from current HEAD (rebase/force-push?) - re-baselined without predicting: ${error instanceof Error ? error.message : String(error)}`,
    }, null, 2), "utf8");
    console.log(JSON.stringify({ ok: true, firstPoll: false, newHeadSha: currentHeadSha, predictionsComputed: 0, rebaselined: true }));
    return;
  }

  const truncatedNewCommitCount = Math.max(0, newShas.length - MAX_NEW_COMMITS_PER_POLL);
  const shasToPredict = newShas.slice(0, MAX_NEW_COMMITS_PER_POLL);

  const profile = analyzeRepository({ repoPath, excludeDirs: EXCLUDE_DIRS });
  const parsedWorkflows = parseRepositoryWorkflows(profile, repoPath);
  const taskRegistry = buildGenericTaskRegistry(profile, primaryLanguage, parsedWorkflows);

  const predictions: unknown[] = [];
  const errors: string[] = [];
  const nowIso = () => new Date().toISOString();

  for (const headSha of shasToPredict) {
    try {
      const baseSha = git(["rev-parse", `${headSha}^`], repoPath);
      const gitResult = await analyzeGitDelta({ repoPath, baseSha, headSha });
      if (!gitResult.success) {
        errors.push(`${headSha}: git-delta-failed: ${gitResult.error}`);
        continue;
      }

      const logicalDeltaKey = computeLogicalDeltaKey({ repository: `${owner}/${name}`, baseSha, headSha, diffciAnalysisVersion, graphVersion });
      const identity: CommitDelta = {
        repository: `${owner}/${name}`, baseSha, headSha, logicalDeltaKey,
        experimentId: "stage2-shadow-poll", diffCiVersion: diffciAnalysisVersion, schemaVersion: "stage2-shadow-poll-1",
        category: "unknown", gitDelta: gitResult.delta,
      };

      const predictionCreatedAt = nowIso(); // captured immediately before the analysis it timestamps
      const analysis = await runDiffCIAnalysis({ repoPath, commitDelta: identity, taskRegistry, excludeDirs: EXCLUDE_DIRS, timeoutMs: 180_000 });

      // Individual-test-level PATH comparison (not the coarse task-level one) - reuses the real
      // production PATH baseline, same as the Stage 0 benchmark runner (runner.ts).
      const pathBaseline = runPathBaseline(analysis.profile.testFilePaths, gitResult.delta.files);
      const testsSelectedByPath = pathBaseline.selectedTests.length;

      // SEPARATELY, task-level PATH selection (which of the task-registry's jobs PATH would run) - this
      // is what reconciliation needs to determine whether PATH would have preserved a specific failing
      // real CI job, distinct from the test-file-level comparison above.
      const pathTaskBaseline = runGenericPathBaseline(taskRegistry, gitResult.delta.files);

      const opportunityCategory = classifyOpportunity({
        fallback: analysis.classification.fallbackRequired,
        testsSelectedByPath,
      });

      predictions.push({
        logicalDeltaKey,
        repository: `${owner}/${name}`,
        baseSha,
        headSha,
        diffciAnalysisVersion,
        graphVersion,
        engineSourceSha,
        planMode: analysis.classification.fallbackRequired ? "FULL" : "SELECTIVE",
        fallback: analysis.classification.fallbackRequired,
        effectiveGraphConfidence: analysis.classification.graphConfidence,
        opportunityCategory,
        testsSelectedDiffci: analysis.plan.selectedTests.length,
        testsSelectedPath: testsSelectedByPath,
        testsTotalFull: analysis.profile.testFilePaths.length,
        diffciAnalysisOverheadMs: analysis.timing.totalDiffCiOverheadMs,
        changedFiles: gitResult.delta.files.map((f) => f.path),
        predictionCreatedAt,
        // The full ExecutionPlan and PATH's full selected-test list, not just counts - reconciliation
        // (src/shadow/reconcile.ts) needs these to match real failed tasks/tests against what each
        // baseline would actually have selected, and re-deriving them later would mean re-running
        // analysis against a possibly-since-changed repo state instead of using what was really predicted.
        plan: analysis.plan,
        pathSelectedTests: pathBaseline.selectedTests,
        pathSelectedTaskIds: pathTaskBaseline.selectedTaskIds,
      });
    } catch (error: unknown) {
      errors.push(`${headSha}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  writeFileSync(outPath, JSON.stringify({
    ok: true, owner, name, firstPoll: false, newHeadSha: currentHeadSha,
    newCommitCount: newShas.length, truncatedNewCommitCount, predictions, errors,
  }, null, 2), "utf8");
  console.log(JSON.stringify({ ok: true, newHeadSha: currentHeadSha, predictionsComputed: predictions.length, errors: errors.length, truncatedNewCommitCount }));
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
