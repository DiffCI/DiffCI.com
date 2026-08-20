import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runShadowExperiment } from "../src/shadow/experiment.js";
import { DiffCiPersistence } from "../src/shadow/persistence.js";
import { resolveCommitRange } from "../src/shadow/commit-resolution.js";

// One level up from scripts/ - see diffci.ts's comment for why this changed from "../.." on 2026-08-21.
const repoPath = resolve(dirname(import.meta.filename), "..");
const SHADOW_DIR = resolve(repoPath, ".diffci/shadow");
const EXPLAIN_DIR = resolve(SHADOW_DIR, "explain");
const EXCLUDE_DIRS = ["node_modules", ".next", "dist", "build"];

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const result: Record<string, string | undefined> = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    const next = args[i + 1];
    if (key === "--base" && next && !next.startsWith("-")) {
      result.base = args[++i];
    } else if (key === "--head" && next && !next.startsWith("-")) {
      result.head = args[++i];
    }
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv);
  const head = args.head ?? process.env.GITHUB_SHA;

  const resolved = resolveCommitRange({
    baseArg: args.base,
    headArg: head,
    eventName: process.env.GITHUB_EVENT_NAME,
    githubBefore: process.env.GITHUB_EVENT_BEFORE,
    githubSha: process.env.GITHUB_SHA,
    githubBaseSha: process.env.GITHUB_BASE_SHA,
    prBaseSha: process.env.GITHUB_PR_BASE_SHA,
    repoPath,
    allowLocalFallback: true,
  });

  if (!resolved.baseSha || !resolved.headSha) {
    console.error("Usage: diffci-shadow --base <sha> --head <sha>");
    console.error("Alternatively set GitHub event metadata (GITHUB_SHA + GITHUB_BASE_SHA / GITHUB_EVENT_BEFORE).");
    console.error(resolved.reason);
    process.exit(1);
  }

  const base = resolved.baseSha;
  const headSha = resolved.headSha;

  const persistence = new DiffCiPersistence({ directory: SHADOW_DIR });
  await persistence.init();

  const experiment = await runShadowExperiment({
    repoPath,
    baseSha: base,
    headSha,
    excludeDirs: EXCLUDE_DIRS,
    cacheDir: resolve(repoPath, ".diffci/cache/graphs"),
    repository: process.env.GITHUB_REPOSITORY,
    githubRunId: process.env.GITHUB_RUN_ID,
    githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT ? Number(process.env.GITHUB_RUN_ATTEMPT) : undefined,
    workflow: process.env.GITHUB_WORKFLOW,
    eventName: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF,
    actor: process.env.GITHUB_ACTOR,
    token: process.env.GITHUB_TOKEN,
  });

  persistence.recordShadow(experiment.record);

  mkdirSync(EXPLAIN_DIR, { recursive: true });
  // eslint-disable-next-line prefer-named-capture-group
  const safeKey = experiment.identity.logicalKey.replace(/[<>:"|?*\\/]/g, "_");
  const explainPath = resolve(EXPLAIN_DIR, `${safeKey}.md`);
  (await import("node:fs")).writeFileSync(explainPath, experiment.record.explainArtifact ?? "");

  const summary = {
    logicalKey: experiment.identity.logicalKey,
    executionKey: experiment.identity.executionKey,
    mode: experiment.record.plan.mode,
    baseSha: base,
    headSha: headSha,
    taskReductionPercent: experiment.record.actualTasks.length
      ? ((experiment.record.actualTasks.length - experiment.record.proposedTasks.length) / experiment.record.actualTasks.length) * 100
      : 0,
    cacheHit: experiment.record.cacheMetrics?.cacheHit ?? false,
    diffCiOverheadMs: experiment.record.timing.totalDiffCiOverheadMs,
    baselineStatus: experiment.record.baseline?.status ?? "NOT_FETCHED",
    baselineJobsObserved: experiment.record.baseline?.jobs.length ?? 0,
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error: unknown) => {
  console.error("DiffCI shadow experiment failed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
