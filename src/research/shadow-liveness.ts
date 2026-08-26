/**
 * Shadow liveness: is DiffCI actually observing this repository right now? (External Shadow Pilot M3.2,
 * 2026-08-26). Pure - no I/O, no clock beyond the `now` passed in.
 *
 * WHY THIS EXISTS, from a real misdiagnosis worth recording. M3.1's report proudly said "3 of 3 eligible
 * commits, 100% capture coverage" while shadow_repositories.last_polled_at for unjs/h3 sat five days
 * stale. That was read as a five-day observation outage - wrongly. The cron had in fact run 144 times a
 * day, every day, with zero errors: last_polled_at only advances on an ACTUAL poll, and a head-check that
 * skips an unchanged repository never touches it. The pipeline was perfectly healthy; the repositories
 * simply had no new commits (h3's head had not moved since Aug 20, and defu's not since May).
 *
 * Both readings - "healthy" and "dead" - produced identical observable symptoms: no new predictions and a
 * frozen last_polled_at. That ambiguity is the actual defect. So this module's job is not merely to raise
 * an alarm when polling stops; it is to make "DiffCI is broken" and "this repository is quiet"
 * structurally impossible to confuse.
 *
 * Hence IDLE_UPSTREAM as a first-class state. Without it, a low-activity repository looks exactly like an
 * outage, and an operator either chases a phantom bug (as happened here) or learns to ignore the signal.
 *
 * `cronEnabled: true` must never imply "shadow healthy" - those were proven to be different things.
 * Health is computed from several independent facts, and any one of them can veto LIVE.
 */

export type ShadowLivenessState =
  /** Polls completing on schedule, source current, no persistent errors. Evidence can accumulate. */
  | "LIVE"
  /** Polling is healthy, but this repository has produced no new default-branch commits. NOT a DiffCI
   * fault, and explicitly not an outage - evidence is not accumulating because there is nothing upstream
   * to observe. */
  | "IDLE_UPSTREAM"
  /** Polls are happening, but analysis/prediction is failing persistently. */
  | "DEGRADED"
  /** Deliberately fail-closed: the deployed analyzer does not match the current source revision, so
   * autonomous analysis refuses to run. Correct behaviour, but evidence stops accumulating. */
  | "PAUSED_SOURCE_INTEGRITY"
  /** No polling activity where polling was expected. The genuine outage case. */
  | "STALE";

export interface ShadowLivenessFacts {
  cronEnabled: boolean;
  /** computeSourceIntegrity()'s status: "CURRENT" | "STALE" | "MISSING" | "UNKNOWN", or undefined when
   * this sweep never consulted the archive. NOTE: this fact did NOT detect the 2026-08-26 liveness
   * ambiguity and must not be credited with doing so - it was never consulted during head-check-only
   * sweeps and was never observed non-CURRENT. It is retained because the invariant it protects is worth
   * keeping, not because it caught anything here. */
  sourceIntegrityStatus: string | undefined;

  /** When DiffCI last CHECKED this repository's upstream head. A head-check that skips an unchanged
   * repository still counts - the poller genuinely ran. This, not lastPollSuccessAt, is what decides
   * whether observation is alive, and confusing the two is what produced the original misdiagnosis. */
  lastHeadCheckAt: string | undefined;
  /** The upstream head DiffCI most recently saw. */
  lastObservedHeadSha: string | undefined;
  /** When that upstream head last actually MOVED. Old means the repository is quiet, never that DiffCI
   * is broken. */
  lastHeadChangedAt: string | undefined;
  /** When DiffCI last attempted a full analysis poll (as opposed to a cheap head check). */
  lastPollAttemptAt: string | undefined;
  /** When such a poll last SUCCEEDED. */
  lastPollSuccessAt: string | undefined;

  consecutiveHeadCheckErrors: number;
  consecutivePollErrors: number;

  /** How often a head check is expected, in ms. Older than a small multiple of this means STALE. */
  expectedPollIntervalMs: number;
  now: Date;
}

export interface ShadowLivenessAssessment {
  state: ShadowLivenessState;
  /** Plain-language reason, written for a maintainer rather than an operator. */
  reason: string;
  /** Whether savings evidence can currently accumulate. False for every state except LIVE. */
  evidenceAccumulating: boolean;
  msSinceLastHeadCheck: number | undefined;
  msSinceLastPollSuccess: number | undefined;
  msSinceHeadChanged: number | undefined;
}

/** A sweep is considered missing after this many expected intervals - tolerates ordinary scheduler jitter
 * without tolerating a genuine outage. */
const MISSED_SWEEP_TOLERANCE = 3;

function msSince(iso: string | undefined, now: Date): number | undefined {
  if (!iso) return undefined;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? Math.max(0, now.getTime() - t) : undefined;
}

export function assessShadowLiveness(facts: ShadowLivenessFacts): ShadowLivenessAssessment {
  const msSinceLastHeadCheck = msSince(facts.lastHeadCheckAt, facts.now);
  const msSinceLastPollSuccess = msSince(facts.lastPollSuccessAt, facts.now);
  const msSinceHeadChanged = msSince(facts.lastHeadChangedAt, facts.now);
  const base = { msSinceLastHeadCheck, msSinceLastPollSuccess, msSinceHeadChanged };

  // Ordered by severity: a cause that stops observation outright outranks one that merely degrades it.
  if (!facts.cronEnabled) {
    return { state: "STALE", reason: "Autonomous shadow polling is disabled.", evidenceAccumulating: false, ...base };
  }

  const sweepOverdue = msSinceLastHeadCheck === undefined || msSinceLastHeadCheck > facts.expectedPollIntervalMs * MISSED_SWEEP_TOLERANCE;
  if (sweepOverdue) {
    return {
      state: "STALE",
      reason: facts.lastHeadCheckAt ? `DiffCI has not checked this repository since ${facts.lastHeadCheckAt}.` : "DiffCI has never checked this repository.",
      evidenceAccumulating: false,
      ...base,
    };
  }

  // Checked AFTER sweep liveness: an integrity pause is only meaningful if the poller is otherwise
  // running. Note this status is only observable on sweeps that actually consulted the source archive -
  // a sweep where every repository was head-check-skipped never consults it, which is exactly why
  // `undefined` here must NOT be treated as a failure.
  if (facts.sourceIntegrityStatus !== undefined && facts.sourceIntegrityStatus !== "CURRENT") {
    return {
      state: "PAUSED_SOURCE_INTEGRITY",
      reason: "The deployed analyzer does not match the current source revision, so DiffCI has deliberately paused analysis rather than run unverified code.",
      evidenceAccumulating: false,
      ...base,
    };
  }

  const errors = facts.consecutivePollErrors + facts.consecutiveHeadCheckErrors;
  if (errors > 0) {
    return {
      state: "DEGRADED",
      reason: `DiffCI is checking this repository, but has failed ${errors} time(s) in a row (${facts.consecutiveHeadCheckErrors} head check, ${facts.consecutivePollErrors} analysis).`,
      evidenceAccumulating: false,
      ...base,
    };
  }

  // The distinction this module exists for. Polling is healthy and up to date; there is simply nothing
  // new upstream to analyse. Reporting this as an outage sends an operator hunting a bug that is not
  // there - which is precisely what happened before this state existed.
  // Nothing new upstream since DiffCI last successfully analysed this repository. Expressed against the
  // head-change timestamp rather than a SHA comparison, so it stays true even when a head moves and moves
  // back, and so the report can say HOW LONG the repository has been quiet.
  const analysedAt = facts.lastPollSuccessAt ? new Date(facts.lastPollSuccessAt).getTime() : undefined;
  const changedAt = facts.lastHeadChangedAt ? new Date(facts.lastHeadChangedAt).getTime() : undefined;
  const nothingNewUpstream = analysedAt !== undefined && (changedAt === undefined || changedAt <= analysedAt);
  if (nothingNewUpstream) {
    return {
      state: "IDLE_UPSTREAM",
      reason: "DiffCI is observing normally, but this repository has produced no new default-branch commits to analyse.",
      // Deliberately false: evidence genuinely is not growing. It is simply nobody's fault, and the
      // remedy is a more active repository rather than an engineering fix.
      evidenceAccumulating: false,
      ...base,
    };
  }

  return { state: "LIVE", reason: "DiffCI is observing this repository normally.", evidenceAccumulating: true, ...base };
}
