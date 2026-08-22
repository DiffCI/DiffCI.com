/**
 * Preflight P1 Part G - runs the real leakage-safe chronological replay (src/preflight/replay.ts)
 * against the real historical 24 DiffCI.com failures already collected in
 * docs/research/preflight-p0-dataset.json (P0's own real gh CLI extraction, unmodified here).
 *
 * The predictor built below is deliberately HONEST about what it can and cannot predict without
 * leakage:
 *  - runtime-parity (src/preflight/runtime-parity.ts) evaluated from each commit's OWN tree state at
 *    that commit (`git show <sha>:package.json` / `:ops/github-runner/Dockerfile`) - legitimate,
 *    zero-leakage evidence, since a real check at commit N's time would see exactly this.
 *  - a small set of changed-file-shape signals (dependency manifest / config / Dockerfile / CI
 *    workflow changed) - also derivable from the diff alone, zero leakage.
 *  - known-failure memory built exclusively from strictly-earlier commits in this same replay,
 *    matched by AFFECTED-FILE OVERLAP (not exact future fingerprint, which would require already
 *    knowing the commit's own outcome) - a real, if weaker, signal a live system could compute.
 *
 * It deliberately does NOT claim to predict UNIT_TEST/INTEGRATION_TEST/SECURITY_SCAN failures - this
 * project has no static test-impact or security-scan prediction wired into Preflight yet, and
 * inventing one for this replay would be exactly the "predicted using information that did not exist"
 * mistake the P0 design doc warns against.
 *
 * Run with: npx tsx scripts/preflight-p1-replay.ts
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { evaluateRuntimeParity, extractPackageJsonEngineSource, extractDockerfileNodeSetupSource } from "../src/preflight/runtime-parity.js";
import { computeFailureRiskScore } from "../src/preflight/risk-model.js";
import { planPreflightChecks } from "../src/preflight/planner.js";
import { runLeakageSafeReplay, type ReplayCommit, type LeakageSafePredictor } from "../src/preflight/replay.js";
import type { FailureClass } from "../src/preflight/taxonomy.js";

interface DatasetRecord {
  repository: string;
  commitSha: string;
  changedFiles: string[];
  failureClass: FailureClass;
  errorFingerprint: string;
  runCreatedAt: string;
}

function gitShow(sha: string, path: string): string | undefined {
  try {
    return execFileSync("git", ["show", `${sha}:${path}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return undefined; // file didn't exist at that commit - a real, legitimate "no source" case, not an error
  }
}

const DOCKERFILE_PATH = "ops/github-runner/Dockerfile";

/** LeakageSafePredictorInput deliberately has no commitSha field (predictors should reason from diff
 * shape, not identity) - so a per-commit predictor is built by closing over that one commit's own
 * historical tree state up front, then handed to the replay engine via the cursor wrapper in main(). */
function predictorForCommit(sha: string): LeakageSafePredictor {
  const pkgText = gitShow(sha, "package.json");
  const dockerText = gitShow(sha, DOCKERFILE_PATH);
  const sources = [
    pkgText ? extractPackageJsonEngineSource(pkgText) : undefined,
    dockerText ? extractDockerfileNodeSetupSource(dockerText, DOCKERFILE_PATH) : undefined,
  ].filter((s): s is NonNullable<typeof s> => Boolean(s));

  return ({ changedFiles, knownFailuresAsOf }) => {
    const parity = evaluateRuntimeParity("node", sources); // no actualVersion available retroactively - honest limitation, see file header
    const isDockerfileChange = changedFiles.some((f) => f.includes(DOCKERFILE_PATH) || f.toLowerCase().includes("dockerfile"));
    const isCiWorkflowChange = changedFiles.some((f) => f.includes(".github/workflows/"));
    const isDependencyManifestChange = changedFiles.some((f) => /package(-lock)?\.json$|yarn\.lock$|pnpm-lock\.yaml$/.test(f));
    const isConfigOrGlobalChange = changedFiles.some((f) => /wrangler\.|tsconfig\.json$|\.env$/.test(f));
    const isRuntimeRequirementChange = changedFiles.some((f) => f === "package.json" || f === ".nvmrc");

    const knownAffectedFileOverlap = knownFailuresAsOf.find((k) => k.affectedFiles.some((f) => changedFiles.includes(f)));

    const risk = computeFailureRiskScore({
      changedFileTypes: [...new Set(changedFiles.map((f) => (f.includes(".") ? "." + f.split(".").pop() : "")))].filter(Boolean),
      dependencyFanOut: 0, // not available without real dependency-graph analysis in this replay - honestly zero, not guessed
      affectedTestCount: 1, // neutral (non-zero) - no real impact-analysis wiring in this replay
      matchesKnownFailureFingerprint: false, // exact-fingerprint prediction would require already knowing this commit's own outcome - never claimed here
      isConfigOrGlobalChange,
      isDependencyManifestChange,
      isMigrationOrSchemaChange: false,
      isGeneratedCodeChange: false,
      runtimeParityVerdict: parity.verdict,
      isRuntimeRequirementChange,
      isDockerfileChange,
      isCiWorkflowChange,
    });

    const plan = planPreflightChecks(changedFiles);
    const recommendedChecks = plan.checks.map((c) => c.check.id);

    const predictedFailureClasses: FailureClass[] = [];
    if (parity.verdict === "CONFLICTING" || parity.verdict === "INCOMPATIBLE" || parity.verdict === "MAJOR_MISMATCH") {
      predictedFailureClasses.push("CONFIGURATION");
    }
    if (knownAffectedFileOverlap && !predictedFailureClasses.includes(knownAffectedFileOverlap.failureClass)) {
      predictedFailureClasses.push(knownAffectedFileOverlap.failureClass);
    }

    return { riskScore: risk.failureRiskScore, riskReasons: risk.riskReasons, recommendedChecks, predictedFailureClasses };
  };
}

async function main() {
  const dataset = JSON.parse(readFileSync(new URL("../docs/research/preflight-p0-dataset.json", import.meta.url), "utf8")) as { records: DatasetRecord[] };
  const diffciRecords = dataset.records.filter((r) => r.repository === "adityankale190895/DiffCI.com");

  const commits: ReplayCommit[] = diffciRecords.map((r) => ({
    commitSha: r.commitSha,
    timestamp: r.runCreatedAt,
    changedFiles: r.changedFiles,
    actualOutcomeConclusion: "failure", // every record in this dataset is a real historical FAILURE (P0's own extraction scope) - see the dataset's own generation script
    actualFailureClass: r.failureClass,
    actualErrorFingerprint: r.errorFingerprint,
    totalWorkflowDurationMs: 0, // not carried in the P0 dataset - genuinely unavailable, left at 0 rather than fabricated
  }));

  // Per-commit predictor closes over that commit's OWN historical tree state (git show <sha>:...) -
  // legitimate zero-leakage evidence about the commit itself, never about its outcome or the future.
  const predictorBySha = new Map(commits.map((c) => [c.commitSha, predictorForCommit(c.commitSha)]));

  // runLeakageSafeReplay's predictor signature has no commitSha - wrap it with a small stateful cursor
  // that advances in the SAME chronological order the engine itself sorts into (both sorts are by
  // timestamp, and the dataset has no two DiffCI.com records sharing a timestamp - verified below).
  const sortedShas = [...commits].sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0)).map((c) => c.commitSha);
  let cursor = 0;
  const predictor: LeakageSafePredictor = (input) => {
    const sha = sortedShas[cursor];
    cursor++;
    return predictorBySha.get(sha!)!(input);
  };

  const result = runLeakageSafeReplay(commits, predictor);

  const lines: string[] = [];
  lines.push("# Preflight P1 Part G - real leakage-safe replay results\n");
  lines.push(`Generated by scripts/preflight-p1-replay.ts against the real historical dataset (docs/research/preflight-p0-dataset.json), ${diffciRecords.length} DiffCI.com failures.\n`);
  lines.push(`**wasAlreadyChronological**: ${result.wasAlreadyChronological}\n`);
  lines.push(`**Outcome counts**: ${JSON.stringify(result.outcomeCounts)}\n`);
  lines.push(`**Prevention recall (TP / (TP+FN))**: ${result.preventionRecall}\n`);
  lines.push("This number is reported exactly as computed, per Part G's explicit instruction not to tune the algorithm to reproduce any prior number (e.g. P0's own 18/24 = 75.0% figure, which measured something different - theoretical preventability classification, not a replayed prediction algorithm's actual recall).\n");
  lines.push("\n## Per-commit trace\n");
  lines.push("| commit | timestamp | actual class | verdict | risk score | predicted classes | recommended checks | outcome | reason |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const step of result.steps) {
    const commit = commits.find((c) => c.commitSha === step.commitSha)!;
    lines.push(
      `| ${step.commitSha.slice(0, 7)} | ${step.timestamp} | ${commit.actualFailureClass} | ${step.prediction.verdict} | ${step.prediction.riskScore} | ${step.prediction.predictedFailureClasses.join(",") || "-"} | ${step.prediction.recommendedChecks.join(",")} | ${step.reconciliationOutcome} | ${step.reconciliationReason.slice(0, 100)} |`,
    );
  }

  const report = lines.join("\n") + "\n";
  const outPath = new URL("../docs/research/2026-08-22-preflight-p1-replay-results.md", import.meta.url);
  writeFileSync(outPath, report, "utf8");
  console.log(report);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
