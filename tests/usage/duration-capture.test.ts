import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveDurationObservation, computeHistoricalAverageSecondsPerTest } from "../../src/usage/duration-capture.js";
import type { DurationObservation } from "../../src/usage/duration-observation-store.js";

describe("deriveDurationObservation", () => {
  it("derives a real seconds-per-test figure from a real job duration and test count", () => {
    const observation = deriveDurationObservation({ logicalDeltaKey: "k1", repository: "acme/web", headSha: "a".repeat(40), testsTotalFull: 46 }, 92_000, [123], [456, 457], "2026-08-23T00:00:00Z");
    assert.ok(observation);
    assert.equal(observation!.secondsPerTest, 2); // 92s / 46 tests
    assert.equal(observation!.realJobDurationMs, 92_000);
    assert.equal(observation!.observedAt, "2026-08-23T00:00:00Z");
  });

  it("carries real workflow run/job identity through for audit provenance (Part A.4)", () => {
    const observation = deriveDurationObservation({ logicalDeltaKey: "k1", repository: "acme/web", headSha: "a".repeat(40), testsTotalFull: 46 }, 92_000, [123], [456, 457], "2026-08-23T00:00:00Z");
    assert.deepEqual(observation!.workflowRunIds, [123]);
    assert.deepEqual(observation!.jobIds, [456, 457]);
  });

  it("returns null rather than dividing by zero when testsTotalFull is zero", () => {
    const observation = deriveDurationObservation({ logicalDeltaKey: "k1", repository: "acme/web", headSha: "a".repeat(40), testsTotalFull: 0 }, 92_000, [123], [456], "2026-08-23T00:00:00Z");
    assert.equal(observation, null);
  });

  it("returns null for a non-positive real duration - never records a fabricated zero", () => {
    const observation = deriveDurationObservation({ logicalDeltaKey: "k1", repository: "acme/web", headSha: "a".repeat(40), testsTotalFull: 46 }, 0, [123], [456], "2026-08-23T00:00:00Z");
    assert.equal(observation, null);
  });
});

describe("computeHistoricalAverageSecondsPerTest", () => {
  function observation(secondsPerTest: number): DurationObservation {
    return { logicalDeltaKey: "k", repository: "acme/web", headSha: "a".repeat(40), workflowRunIds: [1], jobIds: [1], testsTotalFull: 10, realJobDurationMs: secondsPerTest * 10 * 1000, secondsPerTest, observedAt: "2026-08-23T00:00:00Z" };
  }

  it("is 'unavailable' for zero observations - never a false zero", () => {
    const result = computeHistoricalAverageSecondsPerTest([]);
    assert.equal(result.value, "unknown");
    assert.equal(result.confidence, "unavailable");
  });

  it("averages real observations and tags the result 'historical_estimate'", () => {
    const result = computeHistoricalAverageSecondsPerTest([observation(2), observation(4)]);
    assert.equal(result.value, 3);
    assert.equal(result.confidence, "historical_estimate");
  });

  it("a single real observation is still 'historical_estimate', never 'measured'", () => {
    const result = computeHistoricalAverageSecondsPerTest([observation(5)]);
    assert.equal(result.value, 5);
    assert.equal(result.confidence, "historical_estimate");
  });
});
