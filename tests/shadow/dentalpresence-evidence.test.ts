import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeDentalPresenceEvidence } from "../../scripts/lib/dentalpresence-evidence.js";

const record = () => ({
  schema: "dentalpresence.diffci.full-execution.v1", executionId: "123:100:1:full-test-evidence", providerRepositoryId: "123",
  repository: "adityankale190895/DentalPresence.in", executedSha: "a".repeat(40), eventSha: "a".repeat(40),
  workflowRef: "adityankale190895/DentalPresence.in/.github/workflows/cloudflare-staging-deploy.yml@refs/pull/1/merge",
  workflowSha: "b".repeat(40), initiallyClean: true, headUnchanged: true, inputsUnchanged: true,
  job: "full-test-evidence", event: "pull_request", role: "full", command: "npm test",
  commandSha256: "c".repeat(64), packageSha256: "d".repeat(64), lockfileSha256: "e".repeat(64),
  startedAt: "2026-10-02T00:00:00Z", completedAt: "2026-10-02T00:00:01Z", wallMs: 1000,
  runId: "100", runAttempt: "1", status: "PASS", exitCode: 0, signal: null,
});

test("deduplicates delivery and quarantines conflicting outcomes instead of choosing a success", () => {
  const first = record();
  assert.equal(summarizeDentalPresenceEvidence([first, first]).acceptedExecutions, 1);
  const conflict = summarizeDentalPresenceEvidence([first, { ...first, status: "FAIL", exitCode: 1 }, first]);
  assert.equal(conflict.acceptedExecutions, 0);
  assert.equal(conflict.exclusions.CONFLICTING_EXECUTION_ID, 1);
});

test("rejects mismatched merge commits, observation workflows and incomplete executions", () => {
  for (const mutation of [
    { eventSha: "f".repeat(40) }, { workflowRef: record().workflowRef.replace("cloudflare-staging-deploy", "diffci-observe") },
    { initiallyClean: false }, { status: "RUNNING", completedAt: null }, { signal: "SIGTERM" }, { executionId: "invented" },
    { repository: "foreign/private" }, { command: "npm run check" },
  ]) assert.equal(summarizeDentalPresenceEvidence([{ ...record(), ...mutation }]).acceptedExecutions, 0);
});

test("failed full command remains unclassified and supplies neither recall nor savings", () => {
  const result = summarizeDentalPresenceEvidence([{ ...record(), status: "FAIL", exitCode: 7 }]);
  assert.equal(result.acceptedExecutions, 1);
  assert.equal(result.fullCommandFailuresUnclassified, 1);
  assert.equal(result.failurePreservation, null);
  assert.equal(result.measuredSavings, null);
});
