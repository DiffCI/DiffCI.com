import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { classifyRetrospective, contaminationReason, summarize, toCsv, type ContaminatedRowInput, type GitHubRunSummary } from "../../src/shadow/retrospective-evidence.js";

const EVIDENCE = [".github/workflows/ci.yml"];

function input(over: Partial<ContaminatedRowInput> = {}): ContaminatedRowInput {
  return {
    logicalEventKey: "acme/app:abc:1:1",
    headSha: "abc",
    recordedRunId: "1",
    recordedRunPath: ".github/workflows/diffci-observe.yml",
    recordedConclusion: "success",
    predictionCreatedAt: "2026-08-27T09:54:10.000Z",
    planMode: "SELECTIVE",
    testsSelectedDiffci: 2,
    testsTotalFull: 162,
    ...over,
  };
}

function run(id: number, path: string, conclusion: string | null, createdAt: string, status = "completed", updatedAt?: string): GitHubRunSummary {
  return { id, path, conclusion, status, createdAt, updatedAt: updatedAt ?? (status === "completed" ? new Date(Date.parse(createdAt) + 5 * 60_000).toISOString() : undefined) };
}

describe("contaminationReason", () => {
  it("names why the recorded run could not be evidence", () => {
    assert.equal(contaminationReason(input(), EVIDENCE), "WRONG_WORKFLOW");
    assert.equal(contaminationReason(input({ recordedRunPath: ".github/workflows/ci.yml", recordedConclusion: "cancelled" }), EVIDENCE), "NOT_EXECUTED");
    assert.equal(contaminationReason(input({ recordedConclusion: "skipped" }), EVIDENCE), "WRONG_WORKFLOW_AND_NOT_EXECUTED");
    assert.equal(contaminationReason(input({ recordedRunId: null }), EVIDENCE), "NO_RUN_RECORDED");
    assert.equal(contaminationReason(input({ recordedRunPath: null }), EVIDENCE), "UNRESOLVABLE");
    assert.equal(contaminationReason(input({ recordedRunPath: ".github/workflows/ci.yml", recordedConclusion: "success" }), EVIDENCE), "UNRESOLVABLE", "a row that looks admissible today is surfaced, never silently re-admitted");
  });
});

describe("classifyRetrospective", () => {
  it("judges execution by GitHub, not by the stored conclusion: a stored failure that GitHub reports as skipped is NOT_EXECUTED (the DentalPresence.in 2026-08-21 shape)", () => {
    const row = classifyRetrospective(
      input({ recordedRunId: "21", recordedRunPath: ".github/workflows/ci.yml", recordedConclusion: "failure" }),
      EVIDENCE,
      [run(21, ".github/workflows/ci.yml", "skipped", "2026-08-21T13:00:00.000Z")],
    );
    assert.equal(row.recordedConclusionOnGitHub, "skipped");
    assert.equal(row.contaminationReason, "NOT_EXECUTED");
    assert.equal(row.retroVerdict, "EVIDENCE_NOT_EXECUTED");
    const gone = classifyRetrospective(input({ recordedRunId: "99", recordedRunPath: ".github/workflows/ci.yml", recordedConclusion: "success" }), EVIDENCE, [run(13, ".github/workflows/ci.yml", "success", "2026-08-27T10:00:00.000Z")]);
    assert.equal(gone.recordedConclusionOnGitHub, null, "GitHub no longer lists the recorded run");
    assert.equal(gone.contaminationReason, "UNRESOLVABLE", "falls back to the stored conclusion and stays visible");
  });

  it("picks the earliest EXECUTED evidence-workflow run and says whether the prediction preceded it", () => {
    const row = classifyRetrospective(input(), EVIDENCE, [
      run(10, ".github/workflows/diffci-observe.yml", "success", "2026-08-27T09:50:00.000Z"),
      run(12, ".github/workflows/ci.yml", "success", "2026-08-27T10:30:00.000Z"), // a re-run, later
      run(11, ".github/workflows/ci.yml", "cancelled", "2026-08-27T09:51:00.000Z"),
      run(13, ".github/workflows/ci.yml", "failure", "2026-08-27T10:00:00.000Z"),
    ]);
    assert.equal(row.contaminationReason, "WRONG_WORKFLOW");
    assert.equal(row.retroVerdict, "EVIDENCE_EXECUTED");
    assert.equal(row.retroEvidenceRunId, 13, "the cancelled run is not evidence; the first executed one is");
    assert.equal(row.retroEvidenceConclusion, "failure");
    assert.equal(row.evidenceRunsForHead, 3);
    assert.equal(row.predictionPrecededRetroEvidence, true, "pipeline rule: before completion");
    assert.equal(row.predictionPrecededRetroEvidenceStart, true, "and here even before the run was created");
    assert.equal(row.retroEvidenceCompletedAt, "2026-08-27T10:05:00.000Z");
    assert.equal(row.runsForHead.length, 4, "the whole field is kept, sorted by creation");
    assert.deepEqual(row.runsForHead.map((r) => r.id), [10, 11, 13, 12]);
  });

  it("prediction after the evidence run is recorded as not preceding - the row does not become admissible by being retrospective", () => {
    const row = classifyRetrospective(input({ predictionCreatedAt: "2026-08-27T11:00:00.000Z" }), EVIDENCE, [run(13, ".github/workflows/ci.yml", "success", "2026-08-27T10:00:00.000Z")]);
    assert.equal(row.predictionPrecededRetroEvidence, false);
    assert.equal(row.predictionPrecededRetroEvidenceStart, false);
  });

  it("a poll-detected prediction made after the push but before CI finished passes the completion rule and fails the start rule", () => {
    const row = classifyRetrospective(input({ predictionCreatedAt: "2026-08-27T10:02:00.000Z" }), EVIDENCE, [run(13, ".github/workflows/ci.yml", "success", "2026-08-27T10:00:00.000Z", "completed", "2026-08-27T10:04:00.000Z")]);
    assert.equal(row.predictionPrecededRetroEvidence, true);
    assert.equal(row.predictionPrecededRetroEvidenceStart, false);
    const noCompletion = classifyRetrospective(input(), EVIDENCE, [{ id: 14, path: ".github/workflows/ci.yml", conclusion: "success", status: "completed", createdAt: "2026-08-27T10:00:00.000Z" }]);
    assert.equal(noCompletion.predictionPrecededRetroEvidence, null, "no completion time known - not claimed either way");
  });

  it("distinguishes evidence runs that never executed from no evidence run at all, and an unresolvable head", () => {
    const notExecuted = classifyRetrospective(input(), EVIDENCE, [run(11, ".github/workflows/ci.yml", "cancelled", "2026-09-03T04:00:00.000Z"), run(12, ".github/workflows/ci.yml", null, "2026-09-03T04:00:00.000Z", "queued")]);
    assert.equal(notExecuted.retroVerdict, "EVIDENCE_NOT_EXECUTED");
    assert.equal(notExecuted.evidenceRunsForHead, 2);
    assert.equal(notExecuted.predictionPrecededRetroEvidence, null);
    const none = classifyRetrospective(input(), EVIDENCE, [run(10, ".github/workflows/diffci-observe.yml", "success", "2026-08-27T09:50:00.000Z")]);
    assert.equal(none.retroVerdict, "NO_EVIDENCE_RUN");
    const unresolvable = classifyRetrospective(input(), EVIDENCE, undefined);
    assert.equal(unresolvable.retroVerdict, "UNRESOLVABLE");
    assert.deepEqual(unresolvable.runsForHead, []);
  });
});

describe("summarize + toCsv", () => {
  it("tallies verdicts, reasons, conclusions and precedence, and the CSV has one line per row with a header", () => {
    const rows = [
      classifyRetrospective(input(), EVIDENCE, [run(13, ".github/workflows/ci.yml", "failure", "2026-08-27T10:00:00.000Z")]),
      classifyRetrospective(input({ logicalEventKey: "acme/app:def:2:1", headSha: "def" }), EVIDENCE, []),
      classifyRetrospective(input({ logicalEventKey: "acme/app:ghi:3:1", headSha: "ghi" }), EVIDENCE, undefined),
    ];
    const s = summarize(rows);
    assert.equal(s.rows, 3);
    assert.deepEqual(s.byRetroVerdict, { EVIDENCE_EXECUTED: 1, NO_EVIDENCE_RUN: 1, UNRESOLVABLE: 1 });
    assert.deepEqual(s.byRetroEvidenceConclusion, { failure: 1, null: 2 });
    assert.deepEqual(s.predictionPrecededRetroEvidence, { true: 1, false: 0, null: 2 });
    assert.deepEqual(s.predictionPrecededRetroEvidenceStart, { true: 1, false: 0, null: 2 });
    const csv = toCsv(rows);
    const lines = csv.trimEnd().split("\n");
    assert.equal(lines.length, 4);
    assert.match(lines[0]!, /^logicalEventKey,headSha,/);
    assert.match(lines[0]!, /,recordedConclusion,recordedConclusionOnGitHub,contaminationReason,/);
    assert.match(lines[1]!, /,EVIDENCE_EXECUTED,13,failure,2026-08-27T10:00:00.000Z,2026-08-27T10:05:00.000Z,true,true$/);
  });
});
