/**
 * Push-triggered shadow poll (2026-09-04) - the decision layer behind the Queue consumer that replaced
 * the webhook handler's ctx.waitUntil() poll.
 *
 * Why this exists: a Worker's ctx.waitUntil() is cancelled 30 seconds after the response is sent. The
 * push-triggered poll needs a container (extract source, npm ci, clone, analyse) and only finishes
 * inside that window for a tiny repository on a warm container. Everything slower was killed mid-flight
 * with no durable trace - DentalPresence.in went unobserved for 168 commits and DiffCI.com recorded a
 * prediction for f85cf10 but never advanced its cursor past db903b0. Full write-up:
 * docs/research/2026-09-04-shadow-push-poll-lifetime.md. The analysis-fanout Worker hit the identical
 * bug class on 2026-08-23 and moved to a Durable Object alarm; the shadow poll is a single bounded
 * container run per push, so a Queue consumer (15-minute invocation limit) is the proportionate fix.
 *
 * Same dependency-injected, plain-Node-testable split as shadow-cron.ts and shadow-webhook.ts
 * (tests/research/cloudflare/shadow-push-poll.test.ts); validation-worker.ts wires D1/R2/Sandbox.
 *
 * Accounting it adds that the waitUntil path never had, all reusing the cron's existing machinery:
 * - every attempt is recorded durably (shadow_push_polls) - started, finished, or refused;
 * - an analysis poll reserves a daily launch slot (shadow_analysis_launches) exactly as a cron poll
 *   does, so push-driven container spend counts against the same ceiling;
 * - liveness columns (last_poll_attempt_at / last_poll_success_at / consecutive_poll_errors) are
 *   updated, and a repository that keeps failing is auto-paused with a durable reason - the
 *   vitest-dev/vitest lesson (shadow-cron.ts maxConsecutivePollErrors) applied to the push path too.
 *
 * The cron sweep (shadow-cron.ts) is the safety net: webhook-enrolled repositories are now in its
 * pollable list, so a lost delivery, a refused enqueue, or a consumer that died mid-poll is caught by the
 * next head check within 10 minutes. The two paths are kept from racing on one repository by the
 * cron's pollInFlight check against this table (IN_FLIGHT_WINDOW_MS).
 */

import type { ShadowCronConfig, VerifiedSourceArchive, RepositoryLivenessUpdate } from "./shadow-cron.js";

export type PushPollKind = "poll" | "ci-reproduction-bridge";

export interface PushPollMessage {
  kind: PushPollKind;
  repository: string; // "owner/name"
  /** The push payload's `after` SHA when the delivery carried one - recorded for the audit trail; the
   * poll itself always analyses whatever the default branch's head is at clone time. */
  headSha?: string;
  enqueuedAt: string;
}

export type PushPollOutcome =
  | "succeeded"
  | "failed"
  | "refused-state"
  | "refused-source"
  | "refused-ceiling"
  | "refused-unknown-repository";

export interface PushPollRecord {
  kind: PushPollKind;
  repository: string;
  headSha?: string;
  enqueuedAt: string;
  startedAt: string;
  finishedAt: string;
  outcome: PushPollOutcome;
  predictionsRecorded: number;
  slotNo?: number;
  error?: string;
  /** Free-text context for refusals (e.g. the source-integrity detail) and successes (the bridge's
   * outcome label). */
  detail?: string;
  autoPaused: boolean;
}

/** How long a shadow_push_polls row with finished_at NULL counts as "still running". The longest poll
 * path is prepareContainer (~4 min of timeouts) + the poll exec (4 min), so 15 minutes is generous;
 * beyond it the consumer is presumed dead and the cron may launch its own poll. */
export const IN_FLIGHT_WINDOW_MS = 15 * 60 * 1000;

const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

/** Strict parse of a queue message body - the queue is written only by this Worker, but a malformed
 * message must be acked-and-logged, never retried forever or allowed to reach a shell command. */
export function parsePushPollMessage(body: unknown): PushPollMessage | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  const kind = b.kind;
  const repository = b.repository;
  const enqueuedAt = b.enqueuedAt;
  if (kind !== "poll" && kind !== "ci-reproduction-bridge") return undefined;
  if (typeof repository !== "string" || !REPOSITORY_PATTERN.test(repository)) return undefined;
  if (typeof enqueuedAt !== "string" || !enqueuedAt) return undefined;
  const headSha = typeof b.headSha === "string" && SHA_PATTERN.test(b.headSha) ? b.headSha : undefined;
  return { kind, repository, headSha, enqueuedAt };
}

export interface PushPollDeps {
  getRepositoryState(repository: string): Promise<{ state: string; language: string } | undefined>;
  getVerifiedSourceArchive(): Promise<VerifiedSourceArchive>;
  /** Same contract as ShadowCronDeps.reserveLaunchSlot - one slot per container launch, never refunded. */
  reserveLaunchSlot(repository: string, maxPerDay: number): Promise<{ granted: boolean; slotNo?: number }>;
  recordLaunchOutcome(slotNo: number, outcome: "succeeded" | "failed"): Promise<void>;
  pollRepository(repository: string, language: string, source: File, engineSourceSha: string): Promise<{ predictionsRecorded: number; errors: string[]; newHeadSha?: string }>;
  /** EXTERNAL_ENGINE_BRIDGE_01's independent engine. Optional: an environment without it acks bridge
   * messages as refused rather than failing them. */
  runCiReproductionBridge?(repository: string, source: File): Promise<{ ok: boolean; outcome?: string; error?: string }>;
  recordRepositoryLiveness?(updates: RepositoryLivenessUpdate[]): Promise<void>;
  consecutivePollErrors?(repository: string): Promise<number>;
  pauseRepository?(repository: string, reason: string): Promise<void>;
  /** Durable start marker - returns the row id the finish call updates. Written BEFORE any container
   * work so a consumer that dies mid-poll still leaves an in-flight row behind. */
  beginPushPoll(input: { kind: PushPollKind; repository: string; headSha?: string; enqueuedAt: string; startedAt: string }): Promise<number>;
  finishPushPoll(id: number, record: PushPollRecord): Promise<void>;
  now(): Date;
  log(message: string): void;
}

const NON_POLLABLE_STATES = new Set(["PAUSED", "REMOVED", "UNSUPPORTED"]);

export async function runPushTriggeredPoll(message: PushPollMessage, deps: PushPollDeps, config: ShadowCronConfig): Promise<PushPollRecord> {
  const startedAt = deps.now().toISOString();
  const base = { kind: message.kind, repository: message.repository, headSha: message.headSha, enqueuedAt: message.enqueuedAt, startedAt };

  let rowId: number | undefined;
  try {
    rowId = await deps.beginPushPoll(base);
  } catch (error: unknown) {
    // The durable trail is the whole point of this module; a failure to write it is loud but must not
    // itself stop observation - the poll still runs and the finish write is attempted regardless.
    deps.log(`shadow-push-poll: failed to record start for ${message.repository}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const finish = async (partial: Omit<PushPollRecord, keyof typeof base | "finishedAt">): Promise<PushPollRecord> => {
    const record: PushPollRecord = { ...base, finishedAt: deps.now().toISOString(), ...partial };
    if (rowId !== undefined) {
      try {
        await deps.finishPushPoll(rowId, record);
      } catch (error: unknown) {
        deps.log(`shadow-push-poll: failed to record finish for ${message.repository}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    deps.log(
      `shadow-push-poll (${record.kind}) ${record.repository}: outcome=${record.outcome} predictions=${record.predictionsRecorded}${record.slotNo !== undefined ? ` slot=${record.slotNo}` : ""}${record.error ? ` error=${record.error.slice(0, 500)}` : ""}${record.detail ? ` detail=${record.detail.slice(0, 300)}` : ""}${record.autoPaused ? " AUTO_PAUSED" : ""}`,
    );
    return record;
  };

  const repoState = await deps.getRepositoryState(message.repository);
  if (!repoState) {
    return finish({ outcome: "refused-unknown-repository", predictionsRecorded: 0, autoPaused: false, detail: "no shadow_repositories row - the push webhook enrolls before enqueueing, so this should not happen" });
  }
  if (NON_POLLABLE_STATES.has(repoState.state)) {
    return finish({ outcome: "refused-state", predictionsRecorded: 0, autoPaused: false, detail: `repository is ${repoState.state}` });
  }

  // Source gate BEFORE the launch slot: a refused source never launches a container, so it must not
  // burn budget (the cron reserves first because it batches; here one message is one launch).
  let verified: VerifiedSourceArchive | undefined;
  try {
    verified = await deps.getVerifiedSourceArchive();
  } catch (error: unknown) {
    return finish({ outcome: "refused-source", predictionsRecorded: 0, autoPaused: false, error: `get-source-archive: ${error instanceof Error ? error.message : String(error)}` });
  }
  if (verified.status !== "CURRENT") {
    // Same fail-closed rule as shadow-cron.ts: a STALE/MISSING/UNKNOWN source never produces a
    // prediction. The cron safety net re-examines this repository on its next head check.
    return finish({ outcome: "refused-source", predictionsRecorded: 0, autoPaused: false, detail: `source-integrity-${verified.status}: ${verified.detail}` });
  }

  if (message.kind === "ci-reproduction-bridge") {
    if (!deps.runCiReproductionBridge) {
      return finish({ outcome: "refused-state", predictionsRecorded: 0, autoPaused: false, detail: "ci-reproduction bridge not wired in this environment" });
    }
    try {
      const result = await deps.runCiReproductionBridge(message.repository, verified.file);
      return finish({ outcome: result.ok ? "succeeded" : "failed", predictionsRecorded: 0, autoPaused: false, detail: result.outcome, error: result.error });
    } catch (error: unknown) {
      return finish({ outcome: "failed", predictionsRecorded: 0, autoPaused: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const reservation = await deps.reserveLaunchSlot(message.repository, config.maxPollsPerDay);
  if (!reservation.granted) {
    // Deliberate, recorded refusal - identical semantics to the cron's dailyCeilingRefusals. The head
    // change is real; the cron's head check still records the transition so coverage attributes the
    // miss to the ceiling, not to a system failure.
    return finish({ outcome: "refused-ceiling", predictionsRecorded: 0, autoPaused: false, detail: `daily launch ceiling (${config.maxPollsPerDay}) spent` });
  }
  const slotNo = reservation.slotNo;

  const headCheckAt = deps.now().toISOString();
  try {
    const result = await deps.pollRepository(message.repository, repoState.language, verified.file, verified.archiveSha);
    if (slotNo !== undefined) await safely(deps.recordLaunchOutcome(slotNo, "succeeded"), deps, "record-launch-outcome");
    if (deps.recordRepositoryLiveness) {
      await safely(
        deps.recordRepositoryLiveness([{ repository: message.repository, headCheckAt, observedHeadSha: result.newHeadSha ?? message.headSha, headChanged: true, headCheckFailed: false, pollAttempted: true, pollSucceeded: true }]),
        deps,
        "record-liveness",
      );
    }
    return finish({ outcome: "succeeded", predictionsRecorded: result.predictionsRecorded, slotNo, autoPaused: false, error: result.errors.length ? result.errors.join(" | ") : undefined });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (slotNo !== undefined) await safely(deps.recordLaunchOutcome(slotNo, "failed"), deps, "record-launch-outcome");
    let autoPaused = false;
    if (deps.pauseRepository && deps.consecutivePollErrors) {
      try {
        // consecutivePollErrors is read BEFORE the liveness write below increments it - same
        // priorFailures + 1 arithmetic as shadow-cron.ts.
        const priorFailures = await deps.consecutivePollErrors(message.repository);
        if (priorFailures + 1 >= config.maxConsecutivePollErrors) {
          const reason = `AUTO_PAUSED after ${priorFailures + 1} consecutive failed polls (push-triggered). Last error: ${errorMessage.slice(0, 200)}`;
          await deps.pauseRepository(message.repository, reason);
          autoPaused = true;
        }
      } catch (pauseError: unknown) {
        deps.log(`shadow-push-poll: auto-pause check for ${message.repository} failed: ${pauseError instanceof Error ? pauseError.message : String(pauseError)}`);
      }
    }
    if (deps.recordRepositoryLiveness) {
      await safely(
        deps.recordRepositoryLiveness([{ repository: message.repository, headCheckAt, observedHeadSha: message.headSha, headChanged: true, headCheckFailed: false, pollAttempted: true, pollSucceeded: false }]),
        deps,
        "record-liveness",
      );
    }
    return finish({ outcome: "failed", predictionsRecorded: 0, slotNo, autoPaused, error: errorMessage });
  }
}

async function safely(promise: Promise<unknown>, deps: PushPollDeps, what: string): Promise<void> {
  try {
    await promise;
  } catch (error: unknown) {
    // Telemetry must never take down observation itself (same posture as shadow-cron.ts).
    deps.log(`shadow-push-poll: ${what} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
