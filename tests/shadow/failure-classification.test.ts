import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { classifyFailure } from "../../src/shadow/failure-classification.js";

describe("classifyFailure", () => {
  it("classifies by DiffCI's own task category when known", () => {
    assert.equal(classifyFailure({ taskCategory: "test" }), "TEST_FAILURE");
    assert.equal(classifyFailure({ taskCategory: "build" }), "BUILD_FAILURE");
    assert.equal(classifyFailure({ taskCategory: "typecheck" }), "TYPECHECK_FAILURE");
    assert.equal(classifyFailure({ taskCategory: "lint" }), "LINT_FAILURE");
  });

  it("does not classify a category with no direct failure-type mapping (e.g. 'security') from category alone", () => {
    assert.equal(classifyFailure({ taskCategory: "security" }), "UNKNOWN");
  });

  it("detects rate limiting from error text", () => {
    assert.equal(classifyFailure({ errorText: "API rate limit exceeded for installation" }), "RATE_LIMIT");
    assert.equal(classifyFailure({ errorText: "You have exceeded a secondary rate limit" }), "RATE_LIMIT");
  });

  it("detects infrastructure failures from error text", () => {
    assert.equal(classifyFailure({ errorText: "The runner has received a shutdown signal" }), "INFRASTRUCTURE_FAILURE");
    assert.equal(classifyFailure({ errorText: "connect ECONNRESET" }), "INFRASTRUCTURE_FAILURE");
    assert.equal(classifyFailure({ errorText: "No space left on device" }), "INFRASTRUCTURE_FAILURE");
  });

  it("detects external service failures from error text", () => {
    assert.equal(classifyFailure({ errorText: "npm ERR! network getaddrinfo ENOTFOUND registry.npmjs.org" }), "EXTERNAL_SERVICE");
  });

  it("detects configuration failures from error text", () => {
    assert.equal(classifyFailure({ errorText: "Environment variable DATABASE_URL is not set" }), "CONFIGURATION_FAILURE");
  });

  it("falls back to UNKNOWN rather than guessing when nothing matches", () => {
    assert.equal(classifyFailure({ stepName: "some oddly named step", errorText: "exit code 1" }), "UNKNOWN");
    assert.equal(classifyFailure({}), "UNKNOWN");
  });

  it("flakiness takes precedence over a real task-category match", () => {
    const result = classifyFailure({
      taskCategory: "test",
      flakinessResult: { checked: true, nearbyCommitsChecked: 5, nearbySuccesses: 4, likelyFlaky: true, reason: "4/5 nearby commits succeeded" },
    });
    assert.equal(result, "FLAKY_FAILURE");
  });

  it("does not treat a checked-but-not-flaky result as flaky", () => {
    const result = classifyFailure({
      taskCategory: "test",
      flakinessResult: { checked: true, nearbyCommitsChecked: 5, nearbySuccesses: 0, likelyFlaky: false },
    });
    assert.equal(result, "TEST_FAILURE");
  });
});
