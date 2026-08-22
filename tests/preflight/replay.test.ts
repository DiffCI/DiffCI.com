import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runLeakageSafeReplay, type ReplayCommit, type LeakageSafePredictor } from "../../src/preflight/replay.js";

/** A predictor that flags risk ONLY when it finds a known-failure record whose fingerprint... wait -
 * LeakageSafePredictorInput never exposes a fingerprint to compare against (by design, see
 * replay.ts's header) - this predictor instead flags risk when ANY known-failure record's
 * affectedFiles overlaps with the current commit's changedFiles, the same honest proxy
 * scripts/preflight-p1-replay.ts uses for real data. */
const knownFileOverlapPredictor: LeakageSafePredictor = ({ changedFiles, knownFailuresAsOf }) => {
  const match = knownFailuresAsOf.find((k) => k.affectedFiles.some((f) => changedFiles.includes(f)));
  if (match) {
    return { riskScore: 10, riskReasons: [{ signal: "known_overlap", weight: 10, detail: "overlap" }], recommendedChecks: ["known_pattern_match"], predictedFailureClasses: [match.failureClass] };
  }
  return { riskScore: 0, riskReasons: [], recommendedChecks: [], predictedFailureClasses: [] };
};

describe("runLeakageSafeReplay - Part G leakage safety", () => {
  it("cannot flag the FIRST occurrence of a fingerprint - no memory exists yet at that point", () => {
    const commits: ReplayCommit[] = [
      { commitSha: "c1", timestamp: "2026-08-16T00:00:00Z", changedFiles: ["src/store.ts"], actualOutcomeConclusion: "failure", actualFailureClass: "UNIT_TEST", actualErrorFingerprint: "fp-repeat", totalWorkflowDurationMs: 1000 },
    ];
    const result = runLeakageSafeReplay(commits, knownFileOverlapPredictor);
    assert.equal(result.steps[0]!.knownFailuresAvailableCount, 0);
    assert.equal(result.steps[0]!.prediction.predictedFailureClasses.length, 0, "no memory yet - the predictor structurally could not have known this file was risky");
  });

  it("CAN flag a SECOND occurrence touching the same file, using memory built strictly from the first", () => {
    const commits: ReplayCommit[] = [
      { commitSha: "c1", timestamp: "2026-08-16T00:00:00Z", changedFiles: ["src/store.ts"], actualOutcomeConclusion: "failure", actualFailureClass: "UNIT_TEST", actualErrorFingerprint: "fp-repeat", totalWorkflowDurationMs: 1000 },
      { commitSha: "c2", timestamp: "2026-08-17T00:00:00Z", changedFiles: ["src/store.ts"], actualOutcomeConclusion: "failure", actualFailureClass: "UNIT_TEST", actualErrorFingerprint: "fp-repeat", totalWorkflowDurationMs: 1000 },
    ];
    const result = runLeakageSafeReplay(commits, knownFileOverlapPredictor);
    assert.equal(result.steps[1]!.knownFailuresAvailableCount, 1);
    assert.deepEqual(result.steps[1]!.prediction.predictedFailureClasses, ["UNIT_TEST"]);
  });

  it("a THIRD, unrelated commit touching a different file is unaffected by memory from the first two", () => {
    const commits: ReplayCommit[] = [
      { commitSha: "c1", timestamp: "2026-08-16T00:00:00Z", changedFiles: ["src/store.ts"], actualOutcomeConclusion: "failure", actualFailureClass: "UNIT_TEST", actualErrorFingerprint: "fp-repeat", totalWorkflowDurationMs: 1000 },
      { commitSha: "c2", timestamp: "2026-08-17T00:00:00Z", changedFiles: ["src/store.ts"], actualOutcomeConclusion: "failure", actualFailureClass: "UNIT_TEST", actualErrorFingerprint: "fp-repeat", totalWorkflowDurationMs: 1000 },
      { commitSha: "c3", timestamp: "2026-08-18T00:00:00Z", changedFiles: ["src/unrelated.ts"], actualOutcomeConclusion: "success", totalWorkflowDurationMs: 1000 },
    ];
    const result = runLeakageSafeReplay(commits, knownFileOverlapPredictor);
    assert.equal(result.steps[2]!.prediction.predictedFailureClasses.length, 0);
  });

  it("processes out-of-order input in real chronological order and reports wasAlreadyChronological=false", () => {
    const commits: ReplayCommit[] = [
      { commitSha: "later", timestamp: "2026-08-20T00:00:00Z", changedFiles: [], actualOutcomeConclusion: "success", totalWorkflowDurationMs: 0 },
      { commitSha: "earlier", timestamp: "2026-08-10T00:00:00Z", changedFiles: [], actualOutcomeConclusion: "success", totalWorkflowDurationMs: 0 },
    ];
    const result = runLeakageSafeReplay(commits, knownFileOverlapPredictor);
    assert.equal(result.wasAlreadyChronological, false);
    assert.deepEqual(result.steps.map((s) => s.commitSha), ["earlier", "later"]);
  });

  it("reports wasAlreadyChronological=true for genuinely sorted input", () => {
    const commits: ReplayCommit[] = [
      { commitSha: "earlier", timestamp: "2026-08-10T00:00:00Z", changedFiles: [], actualOutcomeConclusion: "success", totalWorkflowDurationMs: 0 },
      { commitSha: "later", timestamp: "2026-08-20T00:00:00Z", changedFiles: [], actualOutcomeConclusion: "success", totalWorkflowDurationMs: 0 },
    ];
    const result = runLeakageSafeReplay(commits, knownFileOverlapPredictor);
    assert.equal(result.wasAlreadyChronological, true);
  });

  it("computes outcomeCounts and preventionRecall correctly across a mixed batch", () => {
    const alwaysHigh: LeakageSafePredictor = () => ({ riskScore: 10, riskReasons: [], recommendedChecks: ["runtime_parity"], predictedFailureClasses: ["CONFIGURATION"] });
    const commits: ReplayCommit[] = [
      { commitSha: "tp1", timestamp: "2026-08-10T00:00:00Z", changedFiles: [], actualOutcomeConclusion: "failure", actualFailureClass: "CONFIGURATION", totalWorkflowDurationMs: 1000 },
      { commitSha: "fp1", timestamp: "2026-08-11T00:00:00Z", changedFiles: [], actualOutcomeConclusion: "success", totalWorkflowDurationMs: 1000 },
      { commitSha: "tp2", timestamp: "2026-08-12T00:00:00Z", changedFiles: [], actualOutcomeConclusion: "failure", actualFailureClass: "CONFIGURATION", totalWorkflowDurationMs: 1000 },
    ];
    const result = runLeakageSafeReplay(commits, alwaysHigh);
    assert.equal(result.outcomeCounts.TP, 2);
    assert.equal(result.outcomeCounts.FP, 1);
    assert.equal(result.preventionRecall, 1); // 2 TP / (2 TP + 0 FN)
  });

  it("preventionRecall is 'unknown', never 0, when there are zero evaluable TP+FN commits", () => {
    const neverFlags: LeakageSafePredictor = () => ({ riskScore: 0, riskReasons: [], recommendedChecks: [], predictedFailureClasses: [] });
    const commits: ReplayCommit[] = [{ commitSha: "c1", timestamp: "2026-08-10T00:00:00Z", changedFiles: [], actualOutcomeConclusion: "success", totalWorkflowDurationMs: 1000 }];
    const result = runLeakageSafeReplay(commits, neverFlags);
    assert.equal(result.preventionRecall, "unknown");
  });

  it("real regression scenario: a predictor using only known-file-overlap memory has zero recall on the real six/seven-push incident's FIRST occurrence, by construction", () => {
    // Faithfully mirrors the real incident: the failing commits mostly did NOT touch package.json/
    // Dockerfile in their own diffs (that's the whole point of the incident) - a file-overlap-only
    // predictor with no static runtime-parity signal genuinely cannot catch commit #1, honestly
    // demonstrating why runtime-parity's "always" applicability (not file-overlap memory) is the real
    // mechanism that would have caught this - see runtime-parity.test.ts's own regression fixture and
    // scripts/preflight-p1-replay.ts for the real, evidence-backed predictor.
    const commits: ReplayCommit[] = [
      { commitSha: "98b7790", timestamp: "2026-08-22T05:42:06Z", changedFiles: ["src/product/routes.ts"], actualOutcomeConclusion: "failure", actualFailureClass: "CONFIGURATION", actualErrorFingerprint: "ERR_UNKNOWN_BUILTIN_MODULE:node:sqlite", totalWorkflowDurationMs: 78_000 },
    ];
    const result = runLeakageSafeReplay(commits, knownFileOverlapPredictor);
    assert.equal(result.outcomeCounts.FN, 1);
    assert.equal(result.outcomeCounts.TP, 0);
  });
});
