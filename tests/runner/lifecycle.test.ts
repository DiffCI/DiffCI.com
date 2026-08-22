import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertValidTransition, canTransition, InvalidRunnerTransitionError } from "../../src/runner/lifecycle.js";

describe("runner lifecycle - Part 13", () => {
  it("the full happy path is valid step by step", () => {
    const path = ["requested", "provisioning", "ready", "assigned", "busy", "completed", "terminating", "terminated"] as const;
    for (let i = 0; i < path.length - 1; i++) {
      assert.equal(canTransition(path[i]!, path[i + 1]!), true, `${path[i]} -> ${path[i + 1]} should be valid`);
    }
  });

  it("terminated -> busy is impossible (the spec's own named example)", () => {
    assert.equal(canTransition("terminated", "busy"), false);
    assert.throws(() => assertValidTransition("terminated", "busy"), InvalidRunnerTransitionError);
  });

  it("terminate(terminated_runner) is idempotent - terminated -> terminated is explicitly allowed", () => {
    assert.equal(canTransition("terminated", "terminated"), true);
    assert.doesNotThrow(() => assertValidTransition("terminated", "terminated"));
  });

  it("failed is reachable from every pre-terminal state", () => {
    for (const from of ["requested", "provisioning", "ready", "assigned", "busy"] as const) {
      assert.equal(canTransition(from, "failed"), true, `${from} -> failed should be valid`);
    }
  });

  it("terminating is reachable from every non-terminal state (forced cleanup can happen at any point)", () => {
    for (const from of ["requested", "provisioning", "ready", "assigned", "busy", "completed", "failed"] as const) {
      assert.equal(canTransition(from, "terminating"), true, `${from} -> terminating should be valid`);
    }
  });

  it("cannot skip states forward (e.g. requested -> ready directly)", () => {
    assert.equal(canTransition("requested", "ready"), false);
    assert.equal(canTransition("requested", "busy"), false);
    assert.equal(canTransition("provisioning", "assigned"), false);
  });

  it("cannot go backward (e.g. busy -> ready)", () => {
    assert.equal(canTransition("busy", "ready"), false);
    assert.equal(canTransition("completed", "busy"), false);
  });

  it("InvalidRunnerTransitionError carries the from/to states for diagnostics", () => {
    try {
      assertValidTransition("completed", "assigned");
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof InvalidRunnerTransitionError);
      assert.equal(err.from, "completed");
      assert.equal(err.to, "assigned");
    }
  });
});
