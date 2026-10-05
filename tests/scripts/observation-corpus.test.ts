import assert from "node:assert/strict";
import { test } from "node:test";
import { readObservationCorpus } from "../../scripts/lib/observation-corpus.js";

function report() {
  return { schema: "diffci.observation.v1", producedAt: "2026-10-05T06:37:37Z", status: "OBSERVED", stage: "complete",
    repository: { ownerName: "DiffCI/DiffCI.com", providerRepositoryId: "1340874432" },
    observer: { version: "0.3.5", engineSha: "a".repeat(40) },
    ci: { provider: "github-actions", runId: "123", runAttempt: "1", job: "observe" },
    commitRange: { baseSha: "b".repeat(40), headSha: "c".repeat(40) },
    result: { mode: "FULL", selectedTests: ["a.test.ts", "b.test.ts"], totalTestCount: 258,
      fallbackReasons: ["Configuration changed"], pathBaseline: { mode: "FULL", selectedTestCount: 258 } },
    payload: { includesFileContents: false, includesEnvironment: false, includesCredentials: false },
    nonInterference: { worktreeUnchanged: true, reportWrittenOutsideRepository: true }, timings: { totalMs: 100 } };
}

test("imports current self-observation reports and corrects FULL selection counts", () => {
  const summary = readObservationCorpus([report()]);
  assert.equal(summary.rows.length, 1);
  assert.equal(summary.rows[0].decision.selected, 258);
  assert.equal(summary.rows[0].counterfactual.netVersusBaseline, 0);
  assert.equal(summary.rows[0].identity.agentIntegrity, `engine:${"a".repeat(40)}`);
});

test("deduplicates equivalent JSON and quarantines conflicting CI executions", () => {
  const first = report();
  const reordered = Object.fromEntries(Object.entries(first).reverse());
  assert.equal(readObservationCorpus([first, reordered]).duplicateDeliveries, 1);
  const changed = report(); changed.result.mode = "SELECTIVE";
  const conflict = readObservationCorpus([first, changed, first]);
  assert.equal(conflict.conflictingExecutions, 1); assert.equal(conflict.rows.length, 0);
  const rerun = report(); rerun.ci.runAttempt = "2";
  assert.equal(readObservationCorpus([first, rerun]).rows.length, 2);
});

test("malformed reports and missing CI or selector identities remain unavailable", () => {
  const invalid = [null, {}, [], { ...report(), ci: {} }, { ...report(), observer: {} }, { ...report(), payload: { includesCredentials: true } }];
  const summary = readObservationCorpus(invalid);
  assert.equal(summary.invalidRecords, invalid.length); assert.equal(summary.rows.length, 0);
});

test("observed safety boundary violations remain visible rather than being filtered away", () => {
  const input = report(); input.nonInterference.worktreeUnchanged = false; input.payload.includesEnvironment = true;
  const row = readObservationCorpus([input]).rows[0];
  assert.equal(row.integrity.worktreeUnchanged, false);
  assert.equal(row.integrity.includesEnvironment, true);
  assert.equal(row.notes.filter((note) => note.includes("VIOLATED")).length, 2);
});
