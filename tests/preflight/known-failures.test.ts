import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { upsertKnownFailure, matchKnownFailure, recommendFromKnownFailures, type KnownFailureRecord } from "../../src/preflight/known-failures.js";

describe("upsertKnownFailure", () => {
  it("creates a new record with recurrenceCount 1 when none exists", () => {
    const record = upsertKnownFailure(undefined, { errorFingerprint: "fp1", failureClass: "CONFIGURATION", changedFiles: ["package.json"], occurredAt: "2026-08-16T00:00:00.000Z" });
    assert.equal(record.recurrenceCount, 1);
    assert.equal(record.firstSeenAt, "2026-08-16T00:00:00.000Z");
    assert.equal(record.lastSeenAt, "2026-08-16T00:00:00.000Z");
  });

  it("increments recurrenceCount and advances lastSeenAt on a repeat occurrence, keeping firstSeenAt fixed", () => {
    const first = upsertKnownFailure(undefined, { errorFingerprint: "fp1", failureClass: "CONFIGURATION", changedFiles: ["package.json"], occurredAt: "2026-08-16T00:00:00.000Z" });
    const second = upsertKnownFailure(first, { errorFingerprint: "fp1", failureClass: "CONFIGURATION", changedFiles: ["ops/github-runner/Dockerfile"], occurredAt: "2026-08-20T00:00:00.000Z" });
    assert.equal(second.recurrenceCount, 2);
    assert.equal(second.firstSeenAt, "2026-08-16T00:00:00.000Z");
    assert.equal(second.lastSeenAt, "2026-08-20T00:00:00.000Z");
  });

  it("real regression scenario: the six-push incident replayed as six occurrences reaches recurrenceCount 6", () => {
    let record: KnownFailureRecord | undefined;
    const occurredDates = ["2026-08-22T05:42:06Z", "2026-08-22T06:14:01Z", "2026-08-22T06:30:18Z", "2026-08-22T06:50:17Z", "2026-08-22T07:08:21Z", "2026-08-22T08:59:53Z"];
    for (const occurredAt of occurredDates) {
      record = upsertKnownFailure(record, { errorFingerprint: "ERR_UNKNOWN_BUILTIN_MODULE:node:sqlite", failureClass: "CONFIGURATION", changedFiles: ["package.json"], occurredAt });
    }
    assert.equal(record!.recurrenceCount, 6);
    assert.equal(record!.lastSeenAt, "2026-08-22T08:59:53Z");
  });

  it("merges affected files across occurrences without duplicates", () => {
    const first = upsertKnownFailure(undefined, { errorFingerprint: "fp1", failureClass: "BUILD", changedFiles: ["a.ts", "b.ts"], occurredAt: "2026-08-16T00:00:00.000Z" });
    const second = upsertKnownFailure(first, { errorFingerprint: "fp1", failureClass: "BUILD", changedFiles: ["b.ts", "c.ts"], occurredAt: "2026-08-17T00:00:00.000Z" });
    assert.deepEqual([...second.affectedFiles].sort(), ["a.ts", "b.ts", "c.ts"]);
  });

  it("keeps the first-confirmed exposingCheckId rather than overwriting it with a later undefined", () => {
    const first = upsertKnownFailure(undefined, { errorFingerprint: "fp1", failureClass: "CONFIGURATION", changedFiles: [], occurredAt: "t1", exposingCheckId: "runtime_parity" });
    const second = upsertKnownFailure(first, { errorFingerprint: "fp1", failureClass: "CONFIGURATION", changedFiles: [], occurredAt: "t2" });
    assert.equal(second.exposingCheckId, "runtime_parity");
  });
});

describe("matchKnownFailure / recommendFromKnownFailures", () => {
  it("matchKnownFailure finds an exact fingerprint match", () => {
    const known: KnownFailureRecord[] = [{ errorFingerprint: "fp1", failureClass: "BUILD", affectedFiles: [], recurrenceCount: 3, firstSeenAt: "t1", lastSeenAt: "t2" }];
    assert.equal(matchKnownFailure(known, "fp1")?.errorFingerprint, "fp1");
    assert.equal(matchKnownFailure(known, "fp-unknown"), undefined);
  });

  it("recommendFromKnownFailures: no match is explicit that absence of evidence is not evidence of safety", () => {
    const result = recommendFromKnownFailures([], "fp1");
    assert.equal(result.matched, false);
    assert.match(result.recommendation, /not evidence the change is safe/);
  });

  it("recommendFromKnownFailures: a match is reported as a strong signal, explicitly never certainty", () => {
    const known: KnownFailureRecord[] = [{ errorFingerprint: "fp1", failureClass: "CONFIGURATION", affectedFiles: ["package.json"], exposingCheckId: "runtime_parity", recurrenceCount: 6, firstSeenAt: "2026-08-22T05:42:06Z", lastSeenAt: "2026-08-22T08:59:53Z" }];
    const result = recommendFromKnownFailures(known, "fp1");
    assert.equal(result.matched, true);
    assert.match(result.recommendation, /NOT certain/);
    assert.match(result.recommendation, /runtime_parity is confirmed to detect it/);
    assert.match(result.recommendation, /recurred 6 time/);
  });
});
