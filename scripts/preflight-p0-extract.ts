/**
 * Preflight P0 historical-failure extractor (Part 2 of the Preflight spec). Read-only: pulls real failed
 * CI run data via `gh` for DiffCI.com and DentalPresence.in and classifies each using
 * src/preflight/fingerprint.ts + preventability.ts. Writes a JSON dataset to
 * docs/research/preflight-p0-dataset.json - a SEPARATE research artifact, never written into Stage 2F's
 * shadow_predictions/shadow_ground_truth tables or diffci-research D1 database (Part 25).
 *
 * Usage: npx tsx scripts/preflight-p0-extract.ts
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { classifyFailureFromEvidence, computeFailureFingerprint } from "../src/preflight/fingerprint.js";
import { classifyPreventability } from "../src/preflight/preventability.js";
import type { HistoricalFailureRecord } from "../src/preflight/types.js";

function gh(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 50 });
}

interface RunListEntry {
  databaseId: number;
  headSha: string;
  createdAt: string;
  displayTitle: string;
  name: string;
}

function listFailedRuns(repo: string, limit: number): RunListEntry[] {
  const out = gh(["run", "list", "--repo", repo, "--status", "failure", "--limit", String(limit), "--json", "databaseId,headSha,createdAt,displayTitle,name"]);
  return JSON.parse(out);
}

// A blind tail of --log-failed is WRONG for any job that runs post-step cleanup after the actual
// failure (actions/checkout's post-step git-config cleanup, "Cleaning up orphan processes", etc. all
// land AFTER the real error in the raw log) - discovered live while building this extractor, re-running
// it against D1's own real log (run 32545143481): the last 4000 chars were 100% post-job cleanup noise,
// while the actual "not ok 1 - classifies by DiffCI's own task category when known" / AssertionError /
// ERR_TEST_FAILURE lines were at line 1329 of 1752, nowhere near the tail. Instead: find the FIRST line
// matching a real failure-signal pattern and return a window of context around it.
const FAILURE_SIGNAL_PATTERN = /not ok \d|AssertionError|error TS\d{4}|ERR_TEST_FAILURE|ERR_UNKNOWN_BUILTIN_MODULE|eslint|error:|Error:|##\[error\]/;

function getFailedLogTail(repo: string, runId: number, contextLines = 60): string {
  let full: string;
  try {
    full = execFileSync("gh", ["run", "view", String(runId), "--repo", repo, "--log-failed"], { encoding: "utf8", maxBuffer: 1024 * 1024 * 50 });
  } catch (err) {
    return `<log fetch failed: ${err instanceof Error ? err.message : String(err)}>`;
  }
  const lines = full.split("\n");
  const signalIndex = lines.findIndex((l) => FAILURE_SIGNAL_PATTERN.test(l));
  if (signalIndex === -1) return full.slice(-4000); // no recognizable signal anywhere - fall back to the tail, honestly (will classify UNKNOWN, which is correct given no evidence)
  const start = Math.max(0, signalIndex - 5);
  const end = Math.min(lines.length, signalIndex + contextLines);
  return lines.slice(start, end).join("\n");
}

function getChangedFiles(repo: string, sha: string): string[] {
  try {
    const out = execFileSync("gh", ["api", `repos/${repo}/commits/${sha}`, "--jq", ".files[].filename"], { encoding: "utf8" });
    return out.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function extractFailingStepAndCommand(logTail: string): { stepName?: string; command?: string } {
  const stepMatch = logTail.match(/^([\w .()/-]+)\t/m);
  const runMatch = logTail.match(/Run (npm[\w :.\-]+)/);
  return { stepName: stepMatch?.[1]?.trim(), command: runMatch?.[1]?.trim() };
}

async function main() {
  const seenFingerprints = new Map<string, string[]>(); // fingerprint -> list of commit SHAs it was seen on, in chronological order as processed
  const records: HistoricalFailureRecord[] = [];

  // --- DiffCI.com: full, per-run real log inspection (23 runs - small enough to do exhaustively) -----
  const diffciRuns = listFailedRuns("adityankale190895/DiffCI.com", 100).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  console.log(`DiffCI.com: ${diffciRuns.length} failed runs found, extracting...`);
  for (const run of diffciRuns) {
    const logTail = getFailedLogTail("adityankale190895/DiffCI.com", run.databaseId);
    const { stepName, command } = extractFailingStepAndCommand(logTail);
    const failureClass = classifyFailureFromEvidence({ jobName: "check", stepName, command, errorText: logTail });
    const fingerprint = computeFailureFingerprint({ failureClass, jobName: "check", stepName, errorText: logTail });
    const fingerprintSeenBefore = seenFingerprints.has(fingerprint);
    (seenFingerprints.get(fingerprint) ?? seenFingerprints.set(fingerprint, []).get(fingerprint)!).push(run.headSha);

    const changedFiles = getChangedFiles("adityankale190895/DiffCI.com", run.headSha);
    const logFetchFailed = logTail.startsWith("<log fetch failed:");
    const { preventability, reason } = classifyPreventability({ failureClass, fingerprintSeenBefore, insufficientEvidence: logFetchFailed });

    records.push({
      repository: "adityankale190895/DiffCI.com",
      commitSha: run.headSha,
      changedFiles,
      workflow: "CI",
      job: "check",
      failingStep: stepName,
      failureClass,
      errorFingerprint: fingerprint,
      diffciPredictionExisted: false, // Stage 2F is shadow-only and observes this repo, but this dataset does not join against shadow_ground_truth (Part 25: consume via read-only interfaces if ever needed, not done in P0)
      preventability,
      preventabilityReason: reason,
      runId: String(run.databaseId),
      runCreatedAt: run.createdAt,
    });
    console.log(`  ${run.headSha.slice(0, 8)} -> ${failureClass} / ${preventability}`);
  }

  // --- DentalPresence.in: sampled (50 runs, overwhelmingly homogeneous CodeQL failures per the Stage 2D
  // Part 9 audit) - real log inspection on a representative sample, documented explicitly as a sample,
  // not an exhaustive per-run classification (Part 5's own "show numerator and denominator" discipline
  // extends to being honest about sampling here too). --------------------------------------------------
  const dpRuns = listFailedRuns("adityankale190895/DentalPresence.in", 50);
  const dpCodeQL = dpRuns.filter((r) => r.name === "CodeQL");
  const dpOther = dpRuns.filter((r) => r.name !== "CodeQL");
  console.log(`\nDentalPresence.in: ${dpRuns.length} failed runs found (${dpCodeQL.length} CodeQL, ${dpOther.length} other) - sampling...`);

  const sampleSize = 8;
  const sample = dpCodeQL.filter((_, i) => i % Math.ceil(dpCodeQL.length / sampleSize) === 0).slice(0, sampleSize);
  for (const run of sample) {
    const logTail = getFailedLogTail("adityankale190895/DentalPresence.in", run.databaseId);
    const failureClass = classifyFailureFromEvidence({ jobName: run.name, errorText: logTail || "codeql security alert" });
    const fingerprint = computeFailureFingerprint({ failureClass, jobName: run.name, errorText: logTail || "codeql" });
    const { preventability, reason } = classifyPreventability({ failureClass: failureClass === "UNKNOWN" ? "SECURITY_SCAN" : failureClass, fingerprintSeenBefore: false });
    records.push({
      repository: "adityankale190895/DentalPresence.in",
      commitSha: run.headSha,
      changedFiles: [],
      workflow: run.name,
      job: run.name,
      failureClass: failureClass === "UNKNOWN" ? "SECURITY_SCAN" : failureClass,
      errorFingerprint: fingerprint,
      diffciPredictionExisted: false,
      preventability,
      preventabilityReason: `${reason} (sampled from ${dpCodeQL.length} homogeneous CodeQL-named failures)`,
      runId: String(run.databaseId),
      runCreatedAt: run.createdAt,
    });
    console.log(`  [sample] ${run.headSha.slice(0, 8)} -> ${failureClass} / ${preventability}`);
  }
  for (const run of dpOther) {
    records.push({
      repository: "adityankale190895/DentalPresence.in",
      commitSha: run.headSha,
      changedFiles: [],
      workflow: run.name,
      job: run.name,
      failureClass: "UNKNOWN",
      errorFingerprint: `unsampled|${run.name}`,
      diffciPredictionExisted: false,
      preventability: "UNKNOWN",
      preventabilityReason: "not individually inspected in P0 (non-CodeQL, small population)",
      runId: String(run.databaseId),
      runCreatedAt: run.createdAt,
    });
  }

  writeFileSync("docs/research/preflight-p0-dataset.json", JSON.stringify({ generatedAt: new Date().toISOString(), totalDiffciRuns: diffciRuns.length, totalDentalPresenceRuns: dpRuns.length, dentalPresenceSampleSize: sample.length, records }, null, 2));
  console.log(`\nWrote ${records.length} records to docs/research/preflight-p0-dataset.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
