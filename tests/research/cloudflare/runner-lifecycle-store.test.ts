/**
 * runner-lifecycle-store.ts (2026-09-05, repair step 4) against real SQLite with the real migration:
 * the stage trail a qualification reads must be complete and never overwrite earlier facts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { makeD1RunnerLifecycleStore, type D1Binding } from "../../../src/research/cloudflare/runner-lifecycle-store.js";

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../src/research/cloudflare");

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(join(SCHEMA_DIR, "schema-migration-2026-09-05-runner-job-lifecycle.sql"), "utf8"));
  return db;
}

function makeD1(db: DatabaseSync): D1Binding {
  return {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async run() {
              const result = db.prepare(query).run(...(values as never[]));
              return { meta: { changes: Number(result.changes) } };
            },
            async all<T = unknown>() {
              return { results: db.prepare(query).all(...(values as never[])) as T[] };
            },
            async first<T = unknown>() {
              return (db.prepare(query).get(...(values as never[])) ?? null) as T | null;
            },
          };
        },
      };
    },
  };
}

const LABELS = ["self-hosted", "cloudflare", "diffci-job-33951761194-check"];

describe("runner lifecycle store", () => {
  it("records the full stage trail for one pinned job, in order, without overwriting earlier facts", async () => {
    const store = makeD1RunnerLifecycleStore(makeD1(freshDb()));
    const repo = "adityankale190895/DiffCI.com";
    await store.ensureJob({ jobId: 101267766892, repository: repo, installationId: 155363973, workflowRunId: 33951761194, workflowName: "CI", jobName: "check", labels: LABELS, pinned: true, at: "2026-09-05T07:09:16Z" });
    await store.recordQueued(101267766892, "2026-09-05T07:09:16Z");
    await store.appendEvent(101267766892, repo, "workflow_queued", "labels=...", "2026-09-05T07:09:16Z");
    await store.recordDispatchRequested(101267766892, "webhook", "2026-09-05T07:09:16Z");
    const { attempts } = await store.recordDispatchStarted(101267766892, "2026-09-05T07:09:17Z");
    assert.equal(attempts, 1);
    await store.recordTokenMinted(101267766892, "2026-09-05T07:09:18Z");
    await store.recordContainerStarted(101267766892, "cf-job-101267766892", "2026-09-05T07:09:19Z");
    await store.appendEvent(101267766892, repo, "container_started", "runner=cf-job-101267766892", "2026-09-05T07:09:19Z");
    await store.recordAssigned(101267766892, "cf-job-101267766892", "2026-09-05T07:09:50Z");
    await store.recordAssigned(101267766892, "someone-else", "2026-09-05T07:09:51Z"); // a duplicate delivery must not rewrite the first assignment
    await store.recordCompleted(101267766892, "success", "2026-09-05T07:12:03Z");
    await store.recordDisposition(101267766892, "exec-succeeded", undefined, "2026-09-05T07:12:05Z");

    const row = (await store.get(101267766892))!;
    assert.equal(row.pinned, true);
    assert.equal(row.queuedAt, "2026-09-05T07:09:16Z");
    assert.equal(row.dispatchSource, "webhook");
    assert.equal(row.runnerName, "cf-job-101267766892");
    assert.equal(row.assignedRunnerName, "cf-job-101267766892", "first assignment wins");
    assert.equal(row.assignedAt, "2026-09-05T07:09:50Z");
    assert.equal(row.conclusion, "success");
    assert.equal(row.disposition, "exec-succeeded");
    assert.deepEqual((await store.listEvents(101267766892)).map((e) => e.stage), ["workflow_queued", "container_started"]);
  });

  it("the incident shape is visible: the runner spawned for one job is recorded as assigned to another", async () => {
    const store = makeD1RunnerLifecycleStore(makeD1(freshDb()));
    const repo = "adityankale190895/DiffCI.com";
    await store.ensureJob({ jobId: 101267766892, repository: repo, installationId: 1, labels: ["self-hosted", "cloudflare"], pinned: false, at: "t0" });
    await store.ensureJob({ jobId: 101260055348, repository: repo, installationId: 1, labels: ["self-hosted", "cloudflare"], pinned: false, at: "t0" });
    await store.recordContainerStarted(101267766892, "cf-job-101267766892", "t1");
    await store.recordAssigned(101260055348, "cf-job-101267766892", "t2");
    const spawnedFor = (await store.get(101267766892))!;
    const served = (await store.get(101260055348))!;
    assert.equal(spawnedFor.runnerName, "cf-job-101267766892");
    assert.equal(spawnedFor.assignedRunnerName, undefined, "the job the runner was spawned for was never assigned it");
    assert.equal(served.assignedRunnerName, "cf-job-101267766892", "GitHub gave that runner the older job");
  });

  it("dispatch attempts count up and a new attempt clears the previous disposition; in-flight and repository listings work", async () => {
    const store = makeD1RunnerLifecycleStore(makeD1(freshDb()));
    await store.ensureJob({ jobId: 5, repository: "acme/web", installationId: 9, labels: ["self-hosted", "cloudflare"], pinned: false, at: "2026-09-05T08:00:00Z" });
    await store.recordDispatchStarted(5, "2026-09-05T08:00:01Z");
    await store.recordContainerStarted(5, "cf-job-5", "2026-09-05T08:00:02Z");
    await store.recordDisposition(5, "capacity", "max_instances", "2026-09-05T08:00:03Z");
    assert.equal((await store.get(5))!.disposition, "capacity");
    const second = await store.recordDispatchStarted(5, "2026-09-05T08:05:00Z");
    assert.equal(second.attempts, 2);
    assert.equal((await store.get(5))!.disposition, undefined, "a fresh attempt starts with no disposition");
    await store.recordContainerStarted(5, "cf-job-5-a2", "2026-09-05T08:05:01Z");
    assert.equal(await store.countInFlight("2026-09-05T08:00:00Z"), 1);
    assert.deepEqual(await store.listRepositories(), [{ repository: "acme/web", installationId: 9 }]);
    const views = await store.viewsFor([5, 6]);
    assert.equal(views.get(5)!.dispatchAttempts, 2);
    assert.equal(views.has(6), false);
    assert.equal((await store.listRecent("acme/web", 10)).length, 1);
  });
});
