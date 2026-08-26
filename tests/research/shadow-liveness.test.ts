/**
 * Tests for shadow liveness (M3.2). The central case is the regression at the bottom: a healthy but quiet
 * repository must never be reported as an outage, because that exact ambiguity produced a real
 * misdiagnosis on 2026-08-26.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessShadowLiveness, type ShadowLivenessFacts } from "../../src/research/shadow-liveness.js";

const NOW = new Date("2026-08-26T04:00:00Z");
const TEN_MIN = 10 * 60 * 1000;

function facts(overrides: Partial<ShadowLivenessFacts> = {}): ShadowLivenessFacts {
  return {
    cronEnabled: true,
    sourceIntegrityStatus: "CURRENT",
    lastHeadCheckAt: "2026-08-26T03:50:00Z", // 10 minutes ago
    lastObservedHeadSha: "abc123",
    lastHeadChangedAt: "2026-08-26T03:45:00Z", // upstream moved AFTER our last success
    lastPollAttemptAt: "2026-08-21T03:00:00Z",
    lastPollSuccessAt: "2026-08-21T03:00:00Z",
    consecutiveHeadCheckErrors: 0,
    consecutivePollErrors: 0,
    expectedPollIntervalMs: TEN_MIN,
    now: NOW,
    ...overrides,
  };
}

describe("assessShadowLiveness", () => {
  it("LIVE when polls are current, source is CURRENT, and upstream has unanalysed commits", () => {
    const a = assessShadowLiveness(facts());
    assert.equal(a.state, "LIVE");
    assert.equal(a.evidenceAccumulating, true);
  });

  // THE regression this module exists for.
  it("IDLE_UPSTREAM - a healthy poller against a quiet repository is NOT an outage", () => {
    const a = assessShadowLiveness(facts({ lastHeadChangedAt: "2026-08-20T15:45:00Z" }));
    assert.equal(a.state, "IDLE_UPSTREAM");
    assert.equal(a.evidenceAccumulating, false, "evidence genuinely is not growing...");
    assert.ok(a.reason.includes("no new default-branch commits"), "...but the reason must point upstream, not at DiffCI");
    assert.notEqual(a.state, "STALE");
  });

  it("a five-day-old lastPredictionAt does NOT imply an outage when sweeps are current", () => {
    // The exact shape of the 2026-08-26 misdiagnosis: unjs/h3 had not produced a prediction since Aug 21,
    // while the cron had run 144 times a day throughout with zero errors.
    const a = assessShadowLiveness(
      facts({ lastPollSuccessAt: "2026-08-21T03:00:00Z", lastHeadCheckAt: "2026-08-26T03:50:00Z", lastHeadChangedAt: "2026-08-20T15:45:00Z" }),
    );
    assert.equal(a.state, "IDLE_UPSTREAM");
    assert.ok((a.msSinceLastPollSuccess ?? 0) > 4 * 24 * 3600 * 1000, "analysis age is real and reported...");
    assert.ok((a.msSinceLastHeadCheck ?? 0) < TEN_MIN * 2, "...but head-check age is what decides liveness");
  });

  it("STALE when no sweep has completed within the tolerated number of intervals", () => {
    const a = assessShadowLiveness(facts({ lastHeadCheckAt: "2026-08-26T02:00:00Z" })); // 2h > 3x10min
    assert.equal(a.state, "STALE");
    assert.equal(a.evidenceAccumulating, false);
  });

  it("tolerates ordinary scheduler jitter without declaring an outage", () => {
    const a = assessShadowLiveness(facts({ lastHeadCheckAt: "2026-08-26T03:38:00Z" })); // 22 min, under 3x
    assert.notEqual(a.state, "STALE");
  });

  it("STALE when a sweep has never run at all", () => {
    assert.equal(assessShadowLiveness(facts({ lastHeadCheckAt: undefined })).state, "STALE");
  });

  it("STALE when the cron is disabled outright", () => {
    assert.equal(assessShadowLiveness(facts({ cronEnabled: false })).state, "STALE");
  });

  it("PAUSED_SOURCE_INTEGRITY on a non-CURRENT archive, and says so in maintainer language", () => {
    for (const status of ["STALE", "MISSING", "UNKNOWN"]) {
      const a = assessShadowLiveness(facts({ sourceIntegrityStatus: status }));
      assert.equal(a.state, "PAUSED_SOURCE_INTEGRITY", `${status} must pause`);
      assert.equal(a.evidenceAccumulating, false);
      assert.ok(a.reason.includes("deliberately paused"), "a fail-closed pause must read as intentional, not as a crash");
    }
  });

  it("an UNDEFINED integrity status is not a failure - a head-check-only sweep never consults the archive", () => {
    const a = assessShadowLiveness(facts({ sourceIntegrityStatus: undefined }));
    assert.notEqual(a.state, "PAUSED_SOURCE_INTEGRITY");
    assert.equal(a.state, "LIVE");
  });

  it("DEGRADED when sweeps run but analysis keeps failing for this repository", () => {
    const a = assessShadowLiveness(facts({ consecutivePollErrors: 3 }));
    assert.equal(a.state, "DEGRADED");
    assert.equal(a.evidenceAccumulating, false);
    assert.ok(a.reason.includes("3 time(s) in a row"));
  });

  it("cronEnabled alone never implies health - every other fact can still veto LIVE", () => {
    const vetoes: Partial<ShadowLivenessFacts>[] = [
      { sourceIntegrityStatus: "STALE" },
      { consecutivePollErrors: 1 },
      { lastHeadCheckAt: "2026-08-25T00:00:00Z" },
      { lastHeadChangedAt: "2026-08-20T15:45:00Z" },
    ];
    for (const veto of vetoes) {
      const a = assessShadowLiveness(facts({ cronEnabled: true, ...veto }));
      assert.notEqual(a.state, "LIVE", `cronEnabled:true must not survive ${JSON.stringify(veto)}`);
      assert.equal(a.evidenceAccumulating, false);
    }
  });

  it("only LIVE reports evidence as accumulating", () => {
    assert.equal(assessShadowLiveness(facts()).evidenceAccumulating, true);
    for (const veto of [{ cronEnabled: false }, { sourceIntegrityStatus: "STALE" }, { consecutivePollErrors: 2 }]) {
      assert.equal(assessShadowLiveness(facts(veto)).evidenceAccumulating, false);
    }
  });
});
