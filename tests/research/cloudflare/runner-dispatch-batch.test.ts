/**
 * Queue batch consumption (2026-09-06): the jobs of one push are dispatched concurrently, each message
 * keeps its own ack/retry, and a malformed message is acked rather than poisoning the batch.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { consumeDispatchBatch, type DispatchMessage, type DispatchQueueMessage } from "../../../src/research/cloudflare/runner-dispatch.js";

function message(jobId: number, calls: string[]): DispatchQueueMessage {
  return {
    body: { jobId, owner: "acme", repo: "app", installationId: 7, labels: ["self-hosted", `diffci-job-${jobId}`], source: "webhook" },
    ack: () => calls.push(`ack:${jobId}`),
    retry: (o) => calls.push(`retry:${jobId}:${o?.delaySeconds ?? "none"}`),
  };
}

describe("consumeDispatchBatch", () => {
  it("starts every dispatch in the batch before any of them finishes - a push's second job no longer waits for the first", async () => {
    const calls: string[] = [];
    const started: number[] = [];
    const resolvers = new Map<number, () => void>();
    const dispatch = (m: DispatchMessage) =>
      new Promise<void>((resolve) => {
        started.push(m.jobId);
        resolvers.set(m.jobId, resolve);
      });
    const run = consumeDispatchBatch([message(1, calls), message(2, calls)], dispatch);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(started, [1, 2], "both container lifecycles began while neither had resolved");
    assert.deepEqual(calls, [], "nothing acked yet");
    resolvers.get(2)!(); // the second job finishes first - its ack must not wait for the first
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(calls, ["ack:2"]);
    resolvers.get(1)!();
    const outcome = await run;
    assert.deepEqual(calls, ["ack:2", "ack:1"]);
    assert.deepEqual(outcome, { dispatched: 2, retried: 0, malformed: 0 });
  });

  it("retries only the message whose dispatch threw, with the configured delay, and acks the rest", async () => {
    const calls: string[] = [];
    const outcome = await consumeDispatchBatch(
      [message(1, calls), message(2, calls), message(3, calls)],
      async (m) => {
        if (m.jobId === 2) throw new Error("capacity: max_instances reached");
      },
      () => {},
      90,
    );
    assert.deepEqual(calls.sort(), ["ack:1", "ack:3", "retry:2:90"]);
    assert.deepEqual(outcome, { dispatched: 2, retried: 1, malformed: 0 });
  });

  it("acks a malformed message without dispatching it, and still dispatches its batch-mates", async () => {
    const calls: string[] = [];
    const dispatched: number[] = [];
    const bad: DispatchQueueMessage = { body: { jobId: "not-a-number" }, ack: () => calls.push("ack:bad"), retry: () => calls.push("retry:bad") };
    const outcome = await consumeDispatchBatch([bad, message(5, calls)], async (m) => {
      dispatched.push(m.jobId);
    });
    assert.deepEqual(dispatched, [5]);
    assert.deepEqual(calls.sort(), ["ack:5", "ack:bad"]);
    assert.deepEqual(outcome, { dispatched: 1, retried: 0, malformed: 1 });
  });
});
