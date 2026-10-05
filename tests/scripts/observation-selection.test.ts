import assert from "node:assert/strict";
import { test } from "node:test";
import { effectiveTestCount, selectionComparison, summarizeSelectionCohorts, type SelectionObservation } from "../../scripts/lib/observation-selection.js";

test("FULL impact candidates never imply fewer executed tests than the full baseline", () => {
  assert.deepEqual(selectionComparison("FULL", 2, 258, "FULL", 258), { selected: 258, baselineSelected: 258, netVersusBaseline: 0 });
  assert.deepEqual(selectionComparison("FULL", 2, 258, "SELECTIVE", 10), { selected: 258, baselineSelected: 10, netVersusBaseline: -248 });
  assert.equal(selectionComparison("SELECTIVE", 2, 258, "FULL", 2).netVersusBaseline, 256);
  assert.equal(effectiveTestCount("SELECTIVE", 0, 258), 0);
});

test("unknown modes and invalid counts stay unknown", () => {
  for (const total of [undefined, "258", -1, NaN, Infinity, 1.5]) assert.equal(effectiveTestCount("FULL", 2, total), "unknown");
  for (const selected of [undefined, -1, NaN, Infinity, 259, 1.5]) assert.equal(effectiveTestCount("SELECTIVE", selected, 258), "unknown");
  assert.equal(effectiveTestCount("REFUSED", 2, 258), "unknown");
  assert.equal(selectionComparison("SELECTIVE", 2, "unknown", "FULL", 258).netVersusBaseline, "unknown");
});

function row(repository = "DiffCI/DiffCI.com", version = "0.3.5", integrity = "pin-a", analysisMs: unknown = 10): SelectionObservation {
  return { identity: { repository, agentVersion: version, agentIntegrity: integrity, baseSha: "base", headSha: "head" },
    decision: { status: "OBSERVED", mode: "FULL", selected: 2, total: 258 },
    counterfactual: { baselineMode: "FULL", baselineSelected: 258 }, economics: { analysisMs } };
}

test("repository, version and package pin cohorts remain separate; repeated deltas are visible", () => {
  const summary = summarizeSelectionCohorts([row(), row(), row("DentalPresence", "0.3.5"), row(undefined, "0.2.11"), row(undefined, undefined, "pin-b")]);
  assert.equal(summary.length, 4);
  const self = summary.find((cohort) => cohort.repository === "DiffCI/DiffCI.com" && cohort.version === "0.3.5" && cohort.integrity === "pin-a")!;
  assert.equal(self.observations, 2); assert.equal(self.uniqueDeltas, 1);
  assert.equal(self.same, 2); assert.equal(self.fewer, 0);
});

test("timings reject invalid measurements and use median and nearest-rank p90", () => {
  const values = [10, 20, 30, 40, -1, Infinity, NaN, "unknown"];
  const cohort = summarizeSelectionCohorts(values.map((value) => row(undefined, undefined, undefined, value)))[0];
  assert.equal(cohort.timingObservations, 4);
  assert.equal(cohort.medianAnalysisMs, 25); assert.equal(cohort.p90AnalysisMs, 40);
  const missing = row(undefined, undefined, undefined, "unknown"); missing.decision.status = "ERROR";
  const unknown = summarizeSelectionCohorts([missing])[0];
  assert.equal(unknown.medianAnalysisMs, null); assert.equal(unknown.p90AnalysisMs, null);
  assert.equal(unknown.unknownComparisons, 1); assert.equal(unknown.same, 0);
});
