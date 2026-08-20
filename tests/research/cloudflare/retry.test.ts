import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isTransientContainerError, withContainerRetry } from "../../../src/research/cloudflare/retry.js";

// Real finding this guards: unjs/h3's first Stage 0 small-batch validation attempt (2026-08-20) failed
// with "the sandbox container stopped while the operation was pending" - a transient max_instances:1
// container-lifecycle race that recovered cleanly on retry ~1 minute later. See
// diffci/docs/research/2026-08-20-stage0-small-batch-report.md.

function noSleep() {
  return async () => {};
}

describe("isTransientContainerError", () => {
  it("matches the real error message observed in the small batch", () => {
    assert.equal(isTransientContainerError(new Error("The sandbox container stopped while the operation was pending.")), true);
  });

  it("matches other container-lifecycle phrasings case-insensitively", () => {
    assert.equal(isTransientContainerError(new Error("container instance is not ready")), true);
    assert.equal(isTransientContainerError(new Error("Durable Object is overloaded")), true);
    assert.equal(isTransientContainerError(new Error("Network connection lost")), true);
  });

  it("matches the real exec-timeout observed in the Stage 0 medium-batch Gate B (2026-08-21)", () => {
    // pmndrs/zustand's sample-phase exec timed out once, transiently - a manual retry succeeded
    // seconds later. See retry.ts's header comment on this pattern for the full finding.
    assert.equal(isTransientContainerError(new Error("sample-commits failed (exit 124): Command timed out after 120000ms")), true);
    assert.equal(isTransientContainerError(new Error("analyze-batch failed (exit 124): Command timed out after 240000ms")), true);
  });

  it("does NOT match real application-level failures - these must fail fast, not retry into a false success", () => {
    assert.equal(isTransientContainerError(new Error("npm-ci-failed: exit 1")), false);
    assert.equal(isTransientContainerError(new Error("validation script failed (exit 1): TypeError: cannot read property")), false);
    assert.equal(isTransientContainerError(new Error("owner and name required")), false);
    assert.equal(isTransientContainerError(new Error("source-extraction-failed: tar: unexpected EOF")), false);
  });

  it("handles non-Error thrown values without throwing itself", () => {
    assert.equal(isTransientContainerError("a plain string, not an Error"), false);
    assert.equal(isTransientContainerError(undefined), false);
  });
});

describe("withContainerRetry", () => {
  it("returns immediately on first-attempt success with attempts=1 and no retry reasons", async () => {
    const outcome = await withContainerRetry(async () => "ok", { sleep: noSleep() });
    assert.equal(outcome.result, "ok");
    assert.equal(outcome.attempts, 1);
    assert.deepEqual(outcome.retryReasons, []);
  });

  it("retries on a transient failure and succeeds on the second attempt", async () => {
    let calls = 0;
    const outcome = await withContainerRetry(
      async (attempt) => {
        calls++;
        if (attempt === 1) throw new Error("the sandbox container stopped while the operation was pending");
        return "recovered";
      },
      { sleep: noSleep() },
    );
    assert.equal(outcome.result, "recovered");
    assert.equal(outcome.attempts, 2);
    assert.equal(calls, 2);
    assert.equal(outcome.retryReasons.length, 1);
    assert.match(outcome.retryReasons[0]!, /attempt 1:/);
  });

  it("does NOT retry a non-transient (application-level) error - fails fast on attempt 1", async () => {
    let calls = 0;
    await assert.rejects(
      withContainerRetry(
        async () => {
          calls++;
          throw new Error("npm-ci-failed: exit 1");
        },
        { sleep: noSleep() },
      ),
      /npm-ci-failed/,
    );
    assert.equal(calls, 1, "a real application failure must not be retried");
  });

  it("gives up after maxAttempts transient failures and reports the retry history", async () => {
    let calls = 0;
    await assert.rejects(
      withContainerRetry(
        async () => {
          calls++;
          throw new Error("container instance is not ready");
        },
        { maxAttempts: 3, sleep: noSleep() },
      ),
      (error: Error) => {
        assert.match(error.message, /container instance is not ready/);
        assert.match(error.message, /after 3 attempt\(s\)/);
        assert.match(error.message, /attempt 1:[\s\S]*attempt 2:/);
        return true;
      },
    );
    assert.equal(calls, 3, "must stop retrying at maxAttempts, not loop forever");
  });

  it("uses a fresh attempt number on each call, letting the caller build a genuinely new session id", async () => {
    const seenAttempts: number[] = [];
    await withContainerRetry(
      async (attempt) => {
        seenAttempts.push(attempt);
        if (attempt < 3) throw new Error("network connection lost");
        return "done";
      },
      { sleep: noSleep() },
    );
    assert.deepEqual(seenAttempts, [1, 2, 3]);
  });

  it("sleeps with increasing backoff between retries (verified via the injectable sleep hook)", async () => {
    const sleeps: number[] = [];
    await withContainerRetry(
      async (attempt) => {
        if (attempt < 3) throw new Error("sandbox container stopped");
        return "done";
      },
      { sleepMs: (attempt) => attempt * 1000, sleep: async (ms) => void sleeps.push(ms) },
    );
    assert.deepEqual(sleeps, [1000, 2000]);
  });
});
