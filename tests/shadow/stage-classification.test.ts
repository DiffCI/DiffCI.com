import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyJobStage, bucketJobsByStage } from "../../src/shadow/stage-classification.js";

describe("classifyJobStage", () => {
  it("classifies obvious real-world job names correctly", () => {
    assert.equal(classifyJobStage("test"), "test");
    assert.equal(classifyJobStage("Unit Tests"), "test");
    assert.equal(classifyJobStage("build"), "build");
    assert.equal(classifyJobStage("Build and package"), "build");
    assert.equal(classifyJobStage("lint"), "lint");
    assert.equal(classifyJobStage("eslint-check"), "lint");
    assert.equal(classifyJobStage("typecheck"), "typecheck");
    assert.equal(classifyJobStage("tsc --noEmit"), "typecheck");
    assert.equal(classifyJobStage("e2e-tests"), "e2e");
    assert.equal(classifyJobStage("playwright"), "e2e");
  });

  it("e2e/typecheck/lint take precedence over the bare 'test' keyword - order matters", () => {
    // "e2e-test" contains "test" too - must classify as e2e, not test, since it's more specific.
    assert.equal(classifyJobStage("e2e-test-suite"), "e2e");
    assert.equal(classifyJobStage("typecheck-tests"), "typecheck");
  });

  it("an unrecognized job name classifies as 'other', never guessed into a specific stage", () => {
    assert.equal(classifyJobStage("deploy"), "other");
    assert.equal(classifyJobStage("notify-slack"), "other");
    assert.equal(classifyJobStage(""), "other");
  });
});

describe("bucketJobsByStage", () => {
  it("sums real durations per stage, keyed correctly", () => {
    const buckets = bucketJobsByStage([
      { jobName: "test", durationMs: 1000 },
      { jobName: "unit-tests", durationMs: 2000 },
      { jobName: "build", durationMs: 500 },
    ]);
    const test = buckets.find((b) => b.stage === "test")!;
    const build = buckets.find((b) => b.stage === "build")!;
    assert.equal(test.totalDurationMs, 3000);
    assert.deepEqual(test.jobNames, ["test", "unit-tests"]);
    assert.equal(build.totalDurationMs, 500);
  });

  it("a job with no known duration is still classified but contributes 0, never treated as missing entirely", () => {
    const buckets = bucketJobsByStage([{ jobName: "test", durationMs: undefined }]);
    const test = buckets.find((b) => b.stage === "test")!;
    assert.equal(test.totalDurationMs, 0);
    assert.deepEqual(test.jobNames, ["test"]); // still recorded as present, just with unknown cost
  });

  it("empty job list produces an empty bucket list, not an error", () => {
    assert.deepEqual(bucketJobsByStage([]), []);
  });

  it("a real mixed workflow (test + build + lint + unrecognized) buckets each job exactly once", () => {
    const buckets = bucketJobsByStage([
      { jobName: "unit tests", durationMs: 30_000 },
      { jobName: "build", durationMs: 45_000 },
      { jobName: "eslint", durationMs: 8_000 },
      { jobName: "publish-artifact", durationMs: 5_000 },
    ]);
    assert.equal(buckets.length, 4);
    assert.equal(buckets.find((b) => b.stage === "other")!.jobNames[0], "publish-artifact");
  });
});
