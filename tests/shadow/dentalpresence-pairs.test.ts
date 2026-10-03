import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { DENTALPRESENCE_SELECTOR_PINS, dentalPresenceSelectorPins, inspectDentalPresencePair, summarizeDentalPresencePairs } from "../../scripts/lib/dentalpresence-pairs.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function artifact(version = "0.2.11") {
  const head = "a".repeat(40); const base = "b".repeat(40);
  const files = ["selected.test.mjs", "omitted.test.mjs"];
  const fileIds = files.map(hash);
  const predictionBytes = Buffer.from(JSON.stringify({ schema: "diffci.observation.v1", status: "OBSERVED", producedAt: "2026-10-02T00:00:00Z",
    observer: { version }, commitRange: { headSha: head, baseSha: base }, nonInterference: { worktreeUnchanged: true },
    result: { mode: "SELECTIVE", selectedTests: [files[0]], blindSpot: false, unroutedTestPaths: [] } }));
  const prediction = { headSha: head, baseSha: base, frozenSha256: hash(predictionBytes), finalSha256: hash(predictionBytes),
    frozenAt: "2026-10-02T00:00:00Z", frozenMonotonicNs: "1", selectorVersion: version };
  const outcome = (index: number) => ({ kind: "test", fileId: fileIds[index], testId: hash(`case-${index}`), status: "PASS" });
  const arm = (role: string) => ({ role, status: "PASS", executedSha: head, universeSha256: hash("universe"), checkoutStable: true,
    wallMs: role === "full" ? 1000 : 400, startedAt: "2026-10-02T00:00:01Z", completedAt: "2026-10-02T00:00:02Z", startedMonotonicNs: "2",
    phases: [{ index: 0, status: "PASS", exitCode: 0, signal: null, mandatory: false }], expectedPhaseCount: 1,
    coverageComplete: true, fileErrors: 0, unattributed: 0,
    seenFileIds: role === "full" ? fileIds : [fileIds[0]], outcomes: role === "full" ? [outcome(0), outcome(1)] : [outcome(0)] });
  return { predictionBytes, receiptBytes: Buffer.from(JSON.stringify(prediction)), pair: {
    schema: "dentalpresence.diffci.pair.v1", repository: "adityankale190895/DentalPresence.in", runId: "100", runAttempt: "1",
    providerRepositoryId: "123", job: "paired-evidence", eventSha: head, workflowSha: head,
    workflowRef: "adityankale190895/DentalPresence.in/.github/workflows/paired-ci-evidence.yml@refs/pull/1/merge",
    status: "COMPLETE", cleanupConfirmed: true, isolation: "independent-local-clones", cachePolicy: "fresh-workspaces-no-restored-test-cache",
    checkoutTextPolicy: "canonical-git-lf",
    harnessSha256: hash("harness"), executedSha: head, baseSha: base, prediction,
    selectorPackage: { version, integrity: DENTALPRESENCE_SELECTOR_PINS[version] },
    mode: "SELECTIVE", selectedFileIds: [fileIds[0]], fullFileIds: fileIds, fullTestFiles: 2, selectedTestFiles: 1,
    universeSha256: hash("universe"), mandatoryPhaseIndices: [] as number[], analysisWallMs: 100, full: arm("full"), selected: arm("selected"),
  } };
}

test("recomputes runtime with analysis overhead and deduplicates real pair identity", () => {
  const input = artifact();
  const summary = summarizeDentalPresencePairs([input, input]);
  assert.equal(summary.acceptedPairs, 1); assert.equal(summary.duplicateDeliveries, 1);
  assert.equal(summary.grossRuntimeReduction, 0.6); assert.equal(summary.netRuntimeReduction, 0.5);
  assert.equal(summary.regressionRecall, null); assert.equal(summary.realizedSavings, null);
});

test("rejects altered predictions, late freezes, missing coverage and synthetic-head mismatches", () => {
  const mutations = [
    (input: ReturnType<typeof artifact>) => { input.predictionBytes = Buffer.from('{}'); },
    (input: ReturnType<typeof artifact>) => { input.pair.full.startedMonotonicNs = "0"; },
    (input: ReturnType<typeof artifact>) => { input.pair.selected.executedSha = "c".repeat(40); },
    (input: ReturnType<typeof artifact>) => { input.pair.full.seenFileIds = []; },
    (input: ReturnType<typeof artifact>) => { input.pair.mandatoryPhaseIndices.push(99); },
  ];
  for (const mutate of mutations) { const input = artifact(); mutate(input); assert.equal(inspectDentalPresencePair(input).accepted, false); }
});

test("counts an omitted failing case as a possible miss and excludes failure runtimes from savings", () => {
  const input = artifact(); input.pair.full.status = "FAIL";
  input.pair.full.phases[0].status = "FAIL"; input.pair.full.phases[0].exitCode = 1;
  input.pair.full.outcomes[1].status = "FAIL";
  const result = summarizeDentalPresencePairs([input]);
  assert.equal(result.possibleMissPairs, 1); assert.equal(result.omittedFailingCases, 1);
  assert.equal(result.performancePairs, 0); assert.equal(result.netRuntimeReduction, null);
  const changed = structuredClone(input); changed.pair.full.wallMs = 2000;
  const conflict = summarizeDentalPresencePairs([input, changed]);
  assert.equal(conflict.acceptedPairs, 0); assert.equal(conflict.exclusions.CONFLICTING_PAIR, 1);
});

test("malformed artifacts remain unavailable rather than crashing cohort reporting", () => {
  const input = artifact(); (input.pair.full as unknown as { phases: unknown[] }).phases = [null];
  assert.equal(inspectDentalPresencePair(input).accepted, false);
});

test("a conflicting companion prediction quarantines the pair even if pair.json is unchanged", () => {
  const first = artifact(); const altered = structuredClone(first);
  const conflict = { ...altered, predictionBytes: Buffer.from('{}'), receiptBytes: Buffer.from(altered.receiptBytes) };
  const report = summarizeDentalPresencePairs([first, conflict]);
  assert.equal(report.acceptedPairs, 0);
  assert.equal(report.exclusions.CONFLICTING_PAIR, 1);
});

test("accepts reviewed selector pins, partitions cohorts, and rejects unknown or mismatched integrity", () => {
  const historical = artifact(); const current = artifact();
  current.pair.runId = "101";
  const version = "0.3.2";
  current.pair.selectorPackage = { version, integrity: dentalPresenceSelectorPins[version] };
  const prediction = JSON.parse(current.predictionBytes.toString()); prediction.observer.version = version;
  current.predictionBytes = Buffer.from(JSON.stringify(prediction));
  Object.assign(current.pair.prediction, { selectorVersion: version, frozenSha256: hash(current.predictionBytes), finalSha256: hash(current.predictionBytes) });
  current.receiptBytes = Buffer.from(JSON.stringify(current.pair.prediction));
  const report = summarizeDentalPresencePairs([historical, current]);
  assert.equal(report.acceptedPairs, 2);
  assert.deepEqual(Object.keys(report.cohorts), ["0.2.11", "0.3.2"]);
  current.pair.selectorPackage.integrity = historical.pair.selectorPackage.integrity;
  assert.deepEqual(inspectDentalPresencePair(current), { accepted: false, reason: "SELECTOR_IDENTITY" });
  current.pair.selectorPackage.version = "999.0.0";
  assert.equal(inspectDentalPresencePair(current).accepted, false);
});

test("seeded failures cannot enter natural-change or performance cohorts", () => {
  const input = artifact(); Object.assign(input.pair, { seededMutation: { id: "fixture" } });
  assert.deepEqual(inspectDentalPresencePair(input), { accepted: false, reason: "SEEDED_EXPERIMENT" });
});

test("accepts both qualified releases but rejects mismatched and unknown selector pins", () => {
  for (const version of ["0.2.11", "0.3.2"]) assert.equal(inspectDentalPresencePair(artifact(version)).accepted, true);
  const mismatched = artifact("0.3.2");
  mismatched.pair.selectorPackage.integrity = DENTALPRESENCE_SELECTOR_PINS["0.2.11"];
  assert.equal(inspectDentalPresencePair(mismatched).accepted, false);
  assert.equal(inspectDentalPresencePair(artifact("0.3.3")).accepted, false);
});
