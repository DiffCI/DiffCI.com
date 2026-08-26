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
  /** computeSourceIntegrity()'s status: "CURRENT" | "STALE" | "MISSING" | "UNKNOWN". */
  sourceIntegrityStatus: string | undefined;
  /** When the cron last completed a sweep at all - a head-check-only sweep counts, because the poller
   * genuinely ran. This is the fact last_polled_at was mistakenly used for. */
  lastPollAttemptAt: string | undefined;
  /** When a poll last actually analysed this repository and produced predictions. */
  lastPredictionAt: string | undefined;
  /** The repository's current upstream head, and the head DiffCI last analysed. Equal means "nothing new
   * upstream", which is the difference between IDLE_UPSTREAM and a real problem. */
  upstreamHeadSha: string | undefined;
  lastAnalysedHeadSha: string | undefined;
  /** Consecutive recent sweeps that ended in errors for this repository. */
  consecutivePollErrors: number;
  /** How often a sweep is expected, in ms. A sweep older than a small multiple of this means STALE. */
  expectedPollIntervalMs: number;
  now: Date;
}

export interface ShadowLivenessAssessment {
  state: ShadowLivenessState;
  /** Plain-language reason, written for a maintainer rather than an operator. */
  reason: string;
  /** Whether savings evidence can currently accumulate. False for every state except LIVE. */
  evidenceAccumulating: boolean;
  msSinceLastPollAttempt: number | undefined;
  msSinceLastPrediction: number | undefined;
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
  const msSinceLastPollAttempt = msSince(facts.lastPollAttemptAt, facts.now);
  const msSinceLastPrediction = msSince(facts.lastPredictionAt, facts.now);
  const base = { msSinceLastPollAttempt, msSinceLastPrediction };

  // Ordered by severity: a cause that stops observation outright outranks one that merely degrades it.
  if (!facts.cronEnabled) {
    return { state: "STALE", reason: "Autonomous shadow polling is disabled.", evidenceAccumulating: false, ...base };
  }

  const sweepOverdue = msSinceLastPollAttempt === undefined || msSinceLastPollAttempt > facts.expectedPollIntervalMs * MISSED_SWEEP_TOLERANCE;
  if (sweepOverdue) {
    return {
      state: "STALE",
      reason: facts.lastPollAttemptAt ? `No shadow sweep has completed since ${facts.lastPollAttemptAt}.` : "No shadow sweep has ever completed for this repository.",
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

  if (facts.consecutivePollErrors > 0) {
    return {
      state: "DEGRADED",
      reason: `Shadow sweeps are running, but analysis has failed ${facts.consecutivePollErrors} time(s) in a row for this repository.`,
      evidenceAccumulating: false,
      ...base,
    };
  }

  // The distinction this module exists for. Polling is healthy and up to date; there is simply nothing
  // new upstream to analyse. Reporting this as an outage sends an operator hunting a bug that is not
  // there - which is precisely what happened before this state existed.
  const upToDateWithUpstream = facts.upstreamHeadSha !== undefined && facts.upstreamHeadSha === facts.lastAnalysedHeadSha;
  if (upToDateWithUpstream) {
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
