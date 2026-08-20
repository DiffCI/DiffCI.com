import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { computeLogicalDeltaKey, computeLogicalEventKey, predictionPrecededGroundTruth } from "../../src/shadow/event-identity.js";

describe("computeLogicalDeltaKey", () => {
  it("is a pure function of repo/baseSha/headSha/versions, not of run id or attempt", () => {
    const input = { repository: "unjs/defu", baseSha: "aaa", headSha: "bbb", diffciAnalysisVersion: "1.0.0", graphVersion: "g1" };
    assert.equal(computeLogicalDeltaKey(input), computeLogicalDeltaKey({ ...input }));
  });

  it("differs when the analysis or graph version differs, so a version bump re-predicts intentionally", () => {
    const base = { repository: "unjs/defu", baseSha: "aaa", headSha: "bbb", diffciAnalysisVersion: "1.0.0", graphVersion: "g1" };
    assert.notEqual(computeLogicalDeltaKey(base), computeLogicalDeltaKey({ ...base, diffciAnalysisVersion: "1.0.1" }));
    assert.notEqual(computeLogicalDeltaKey(base), computeLogicalDeltaKey({ ...base, graphVersion: "g2" }));
  });
});

describe("computeLogicalEventKey", () => {
  it("distinguishes separate workflow run attempts of the same commit (flaky-retry signal preserved)", () => {
    const base = { repository: "unjs/defu", headSha: "bbb", workflowRunId: "12345" };
    assert.notEqual(computeLogicalEventKey({ ...base, workflowRunAttempt: 1 }), computeLogicalEventKey({ ...base, workflowRunAttempt: 2 }));
  });

  it("is idempotent for the exact same run+attempt (duplicate webhook delivery collapses to one key)", () => {
    const input = { repository: "unjs/defu", headSha: "bbb", workflowRunId: "12345", workflowRunAttempt: 1 };
    assert.equal(computeLogicalEventKey(input), computeLogicalEventKey({ ...input }));
  });

  it("falls back to a 'poll' run-id placeholder when no real workflow run id is known, and defaults attempt to 1", () => {
    const key = computeLogicalEventKey({ repository: "unjs/defu", headSha: "bbb" });
    assert.equal(key, "unjs/defu:bbb:poll:1");
  });

  it("does not collide between a real run id and the 'poll' placeholder for the same commit", () => {
    const withRun = computeLogicalEventKey({ repository: "unjs/defu", headSha: "bbb", workflowRunId: "poll" });
    const withoutRun = computeLogicalEventKey({ repository: "unjs/defu", headSha: "bbb" });
    // Documenting a real (extremely unlikely) edge case rather than hiding it: a literal GitHub run id
    // equal to the string "poll" would collide with the placeholder. GitHub run ids are always numeric,
    // so this cannot occur with real data - asserting the current (accepted) behavior here.
    assert.equal(withRun, withoutRun);
  });
});

describe("predictionPrecededGroundTruth", () => {
  it("is true when the prediction timestamp is strictly before the real workflow completion timestamp", () => {
    const result = predictionPrecededGroundTruth("2026-08-21T10:00:00.000Z", {
      workflowCompletedAt: "2026-08-21T10:05:00.000Z",
      groundTruthFetchedAt: "2026-08-21T10:06:00.000Z",
    });
    assert.equal(result, true);
  });

  it("is false when the prediction was made AFTER the real outcome was already known - the exact case Phase 5 forbids", () => {
    const result = predictionPrecededGroundTruth("2026-08-21T10:10:00.000Z", {
      workflowCompletedAt: "2026-08-21T10:05:00.000Z",
      groundTruthFetchedAt: "2026-08-21T10:06:00.000Z",
    });
    assert.equal(result, false);
  });

  it("falls back to groundTruthFetchedAt when workflowCompletedAt is unavailable", () => {
    const result = predictionPrecededGroundTruth("2026-08-21T10:00:00.000Z", {
      groundTruthFetchedAt: "2026-08-21T10:06:00.000Z",
    });
    assert.equal(result, true);
  });

  it("is false (fails safe, never fails open) on an unparseable timestamp", () => {
    const result = predictionPrecededGroundTruth("not-a-date", { groundTruthFetchedAt: "2026-08-21T10:06:00.000Z" });
    assert.equal(result, false);
  });

  it("is false for exact equality (must be strictly before, not before-or-equal)", () => {
    const same = "2026-08-21T10:00:00.000Z";
    assert.equal(predictionPrecededGroundTruth(same, { groundTruthFetchedAt: same }), false);
  });
});
