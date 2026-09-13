import { strict as assert } from "node:assert";
import { test } from "node:test";
import { freezeTimingHistory, heldOutEconomics, vitestWorkerArguments, type TrainingRecord } from "../../scripts/bypass-benchmark-protocol.js";

test("historical Vitest CLI versions retain explicit two-worker limits", () => {
  assert.deepEqual(vitestWorkerArguments("--maxWorkers <n> --minWorkers <n>"), ["--maxWorkers=2", "--minWorkers=2"]);
  assert.deepEqual(vitestWorkerArguments("--maxThreads <n> --minThreads <n>"), ["--maxThreads=2", "--minThreads=2"]);
  assert.throws(() => vitestWorkerArguments("--maxWorkers <n>"), /Cannot establish/);
});

test("bypass history excludes failures, other configurations and held-out measurements", () => {
  const base: TrainingRecord = { index: 0, headSha: "a".repeat(40), contextKey: "same", stable: true, pairs: [{ fullMs: 1000, policyMs: 1000, observerMs: 700 }] };
  const options = { trainingCount: 8, repository: "owner/repo", jobKey: "unit", observerVersion: "candidate", contextKey: "same", recordedAt: new Date().toISOString() };
  const history = freezeTimingHistory([base, { ...base, index: 1, stable: false }, { ...base, index: 2, contextKey: "other" }, { ...base, index: 3, pairs: [{ fullMs: 1000, policyMs: 0, observerMs: 700 }] }], options);
  assert.equal(history.samples.length, 1);
  assert.deepEqual(history.samples[0], { headSha: base.headSha, stable: true, ...base.pairs[0] });
  assert.throws(() => freezeTimingHistory([{ ...base, index: 8 }], options), /leaked/);
});

test("full bypass reduces analysis cost but remains overhead versus plain full CI", () => {
  const result = heldOutEconomics({ decision: "BYPASS_FULL", fullMs: 10000, policyMs: 10000, gatedObserverMs: 500, forcedObserverMs: 2000 });
  assert.equal(result.controlledNetMs, -500);
  assert.equal(result.improvementOverAlwaysAnalyzeMs, 1500);
  assert.equal(result.missedProfitableSelection, false);
  const missed = heldOutEconomics({ decision: "BYPASS_FULL", fullMs: 10000, policyMs: 1000, gatedObserverMs: 500, forcedObserverMs: 2000 });
  assert.equal(missed.missedProfitableSelection, true);
  assert.equal(missed.alwaysAnalyzeNetMs, 7000);
  assert.equal(missed.controlledNetMs, -500);
  const selective = heldOutEconomics({ decision: "ANALYZE", fullMs: 10000, policyMs: 1000, gatedObserverMs: 2200, forcedObserverMs: 2000 });
  assert.equal(selective.controlledNetMs, 6800);
  assert.equal(selective.improvementOverAlwaysAnalyzeMs, -200);
});
