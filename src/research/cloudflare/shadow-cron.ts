/**
 * Stage 2 autonomous polling (2026-08-21) - the Cron Trigger decision logic that removes the "a human
 * session must drive every poll" dependency the Stage 2 final report flagged. The shadow_repositories
 * schema comment always anticipated this ("REST polling from a Cron Trigger"); until now every
 * /v1/shadow/poll call needed a caller uploading the diffci source tarball per-request, so observation
 * volume only accumulated while someone was babysitting the pipeline. Now the source lives in R2
 * (uploaded once via POST /v1/shadow/source, see validation-worker.ts) and the Worker's scheduled()
 * handler drives poll + reconcile on its own.
 *
 * This module is the DECISION layer only, dependency-injected and unit-testable in plain Node against
 * fakes (tests/research/cloudflare/shadow-cron.test.ts) - the same split resumable-batch.ts and
 * orchestrator-plan.ts use. validation-worker.ts wires the real D1/R2/Sandbox implementations.
 *
 * Cost/latency design: a container poll costs ~2-6 minutes of wall clock (npm ci + clone + analysis)
 * even when nothing new landed, so before spending a container the runner asks the GitHub REST API for
 * the repository's current default-branch head (one cheap request) and skips repositories whose head
 * still equals last_polled_sha. An API failure polls anyway (conservative: observation must not stop
 * because a pre-check flaked) - except 404/451, which mean the repository itself is gone/blocked.
 * A repository's FIRST poll always runs the container: there is no last_polled_sha to compare against,
 * and the poll script itself records the baseline without backfilling history (see
 * cloudflare-shadow-poll.ts's prospectiveness comment).
 */

import type { SourceIntegrityResult } from "./shadow-source-integrity.js";

/** Either the verified-current source archive plus the exact SHA it was built from, or a refusal that
 * carries the same integrity result GET /v1/shadow/cron-status reports - so a caller inspecting a
 * ShadowCronRunRecord's errors and a caller inspecting the live status endpoint are never looking at two
 * different explanations for the same problem. */
export type VerifiedSourceArchive =
  | (Omit<SourceIntegrityResult, "archiveSha"> & { status: "CURRENT"; file: File; archiveSha: string })
  | (SourceIntegrityResult & { status: Exclude<SourceIntegrityResult["status"], "CURRENT"> });

export interface PollableRepository {
  repository: string; // "owner/name"
  state: string;
  language: string;
  lastPolledSha?: string;
  lastPolledAt?: string;
}

export interface ShadowCronRunRecord {
  /** Head transitions DETECTED this sweep but not analysed because the daily launch ceiling was already
   * spent. Distinct from headChecksSkipped (nothing changed) and from an error: the change is real, was
   * observed, and was deliberately deferred. Kept separate so eligible-capture coverage can attribute a
   * miss to a ceiling rather than to a system failure. */
  dailyCeilingRefusals?: number;
  /** Head transitions detected this sweep, whether or not they were analysed. */
  headTransitionsDetected?: number;
  /** Repositories auto-paused this sweep for persistent failure. Recorded loudly: a repository silently
   * dropping out of observation is exactly the ambiguity M3.2 exists to prevent. */
  autoPaused?: string[];
  /** Container-launch accounting. attempted = launches this sweep wanted; allowed = slots granted;
   * succeeded/failed = how those granted launches finished. attempted always equals
   * allowed + refusedByCeiling, and allowed always equals succeeded + failed. These are deliberately
   * SEPARATE from reposPolled/predictionsRecorded, which remain success/observation counts and are not
   * redefined as attempts. */
  launchesAttempted?: number;
  launchesAllowed?: number;
  launchesSucceeded?: number;
  launchesFailed?: number;
  startedAt: string;
  finishedAt: string;
  trigger: "cron" | "manual";
  reposConsidered: number;
  headChecksSkipped: number; // repositories skipped because remote head == last_polled_sha
  reposPolled: string[];
  predictionsRecorded: number;
  reposReconciled: number;
  groundTruthReconciled: number;
  stillPending: number;
  errors: string[];
  /** computeSourceIntegrity()'s status for this run, if a poll was attempted (undefined when nothing
   * needed polling this cycle, so the source archive was never even consulted). */
  sourceIntegrityStatus?: string;
}

/** Per-repository liveness facts observed during one sweep (M3.2). Deliberately separates a HEAD CHECK
 * (cheap, happens every sweep, and is what proves observation is alive) from an ANALYSIS POLL (expensive,
 * only when the head moved). Conflating the two is what made a healthy-but-quiet repository look like a
 * five-day outage on 2026-08-26. */
export interface RepositoryLivenessUpdate {
  repository: string;
  headCheckAt: string;
  observedHeadSha?: string;
  /** True when the observed head differs from the last head DiffCI analysed. */
  headChanged: boolean;
  headCheckFailed: boolean;
  pollAttempted: boolean;
  pollSucceeded: boolean;
}

export interface ShadowCronDeps {
  /**
   * Optional: atomically reserve ONE daily launch slot immediately before starting a container. Returns
   * granted:false when the day's budget is spent. The slot is consumed regardless of how the launch
   * turns out - success, clone-exclusion, timeout or crash - because the container cost is incurred
   * either way. Never called for work refused before a launch.
   */
  reserveLaunchSlot?(repository: string, maxPerDay: number): Promise<{ granted: boolean; slotNo?: number }>;
  /** Optional: records how a reserved launch finished. Never frees the slot. */
  recordLaunchOutcome?(slotNo: number, outcome: "succeeded" | "failed"): Promise<void>;
  /** Optional: pauses a repository that keeps failing, with a durable reason. Explicit refusal - the
   * repository stops costing containers, its finding is preserved, and re-enabling it is a data change. */
  pauseRepository?(repository: string, reason: string): Promise<void>;
  /** Optional: consecutive prior poll failures per repository, for the refusal threshold. */
  consecutivePollErrors?(repository: string): Promise<number>;
  /** Optional: append-only record of an observed head transition. Written for EVERY detected change,
   * including ones the daily ceiling defers - a deferred transition is still a real observation, and
   * discarding it would destroy the missed-commit measurement. */
  recordHeadTransition?(t: { repository: string; fromSha?: string; toSha: string; detectedAt: string; analysed: boolean }): Promise<void>;
  /** Optional (M3.2): persists the liveness facts above. Absent in older fakes/tests, which simply do not
   * record liveness - never a reason to fail a sweep. */
  recordRepositoryLiveness?(updates: RepositoryLivenessUpdate[]): Promise<void>;
  /** Enrolled cloudflare-poll repositories in a pollable state, oldest-polled first (store-side order
   * is advisory; selection re-sorts defensively). */
  listPollableRepositories(): Promise<PollableRepository[]>;
  /** Repositories eligible for the reconcile sweep - a SUPERSET of the pollable list: webhook-enrolled
   * ('github-app-webhook') repositories reconcile event-driven when workflow_run deliveries arrive, but
   * this cron sweep is their safety net against missed deliveries. */
  listReconcilableRepositories(): Promise<PollableRepository[]>;
  /** Current default-branch head SHA via the GitHub REST API, or undefined when it cannot be
   * determined (rate limit, network) - undefined means "poll anyway". A "gone" result means the
   * repository no longer exists / is blocked and must not consume a container. */
  fetchRemoteHead(repository: string): Promise<{ sha: string } | { gone: string } | undefined>;
  /** The diffci source tarball from R2, gated by source-version integrity (2026-08-21 fix,
   * src/research/cloudflare/shadow-source-integrity.ts) - only ever CURRENT is safe to poll with. A
   * STALE/MISSING/UNKNOWN result must never be silently treated as "good enough"; runShadowCronOnce
   * below refuses to poll in every non-CURRENT case. */
  getVerifiedSourceArchive(): Promise<VerifiedSourceArchive>;
  pollRepository(repo: PollableRepository, source: File, engineSourceSha: string): Promise<{ predictionsRecorded: number; errors: string[] }>;
  reconcileRepository(repository: string): Promise<{ reconciled: number; stillPending: number; errors: string[] }>;
  recordCronRun(run: ShadowCronRunRecord): Promise<void>;
  now(): Date;
  log(message: string): void;
}

export interface ShadowCronConfig {
  /** Containers dispatched per invocation. Must stay comfortably inside the scheduled handler's
   * wall-clock allowance (polls run concurrently, worst-case one poll ~6min) AND below the sandbox
   * max_instances gap - see wrangler.research-sandbox.jsonc's max_instances comment. */
  maxPollsPerRun: number;
  /** Reconciles per invocation - cheap (GitHub API + D1/R2 only, no container), so this cap is about
   * bounding API usage, not time. */
  maxReconcilesPerRun: number;
  /** Pending-prediction rows attempted per reconciled repository (the existing /v1/shadow/reconcile
   * limit semantics). */
  reconcileLimitPerRepo: number;
  /**
   * HARD ceiling on analysis launches per UTC day, across all repositories and all sweeps.
   *
   * maxPollsPerRun bounds one sweep; it does not bound daily spend. At 144 sweeps/day and
   * maxPollsPerRun 3 the uncapped worst case is 432 container launches per day - a number nobody had ever
   * chosen, and which only stayed small because the enrolled repositories were dormant. Enrolling active
   * repositories makes that ceiling real, so it is declared explicitly here rather than discovered on a
   * bill.
   */
  maxPollsPerDay: number;
  /**
   * Consecutive failed analysis polls after which a repository is automatically PAUSED with a recorded
   * reason - explicit refusal rather than engine expansion. vitest-dev/vitest showed why: a
   * deterministically ineligible repository re-fails every sweep, and each failure costs a real container.
   * Reset to zero on any success, so this only fires on persistent failure, never on a transient one.
   */
  maxConsecutivePollErrors: number;
  /** Head checks per sweep. Bounds the cheap GitHub call independently of container launches, so the
   * launch ceiling can never suppress observation. */
  maxHeadChecksPerRun: number;
}

export const DEFAULT_SHADOW_CRON_CONFIG: ShadowCronConfig = {
  maxPollsPerRun: 3,
  maxReconcilesPerRun: 10,
  reconcileLimitPerRepo: 10,
  // Predeclared for the 2-repository ramp (vitest, nitro): ~5-10 real head changes per repository per
  // day expected, so 60 leaves generous headroom while capping the worst case at roughly one seventh of
  // the previously-unbounded 432/day.
  maxPollsPerDay: 60,
  maxHeadChecksPerRun: 25,
  maxConsecutivePollErrors: 5,
};

const POLLABLE_STATES = new Set(["VALIDATING", "SHADOW_ACTIVE", "SHADOW_LIMITED"]);

/** Oldest-polled first (never-polled repositories at the very front), states filtered defensively even
 * though the store query already filters - a store regression must not make the cron poll a PAUSED or
 * REMOVED repository. */
export function selectRepositoriesToPoll(repos: PollableRepository[]): PollableRepository[] {
  return repos
    .filter((r) => POLLABLE_STATES.has(r.state))
    .sort((a, b) => {
      if (!a.lastPolledAt && !b.lastPolledAt) return a.repository.localeCompare(b.repository);
      if (!a.lastPolledAt) return -1;
      if (!b.lastPolledAt) return 1;
      return a.lastPolledAt.localeCompare(b.lastPolledAt) || a.repository.localeCompare(b.repository);
    });
}

export async function runShadowCronOnce(
  deps: ShadowCronDeps,
  config: ShadowCronConfig = DEFAULT_SHADOW_CRON_CONFIG,
  trigger: "cron" | "manual" = "cron",
): Promise<ShadowCronRunRecord> {
  const startedAt = deps.now().toISOString();
  const errors: string[] = [];
  const reposPolled: string[] = [];
  let predictionsRecorded = 0;
  let headChecksSkipped = 0;
  let reposReconciled = 0;
  let groundTruthReconciled = 0;
  let stillPending = 0;
  let sourceIntegrityStatus: string | undefined;
  const autoPaused: string[] = [];
  let launchesSucceeded = 0;
  let launchesFailed = 0;

  let candidates: PollableRepository[] = [];
  try {
    candidates = selectRepositoriesToPoll(await deps.listPollableRepositories());
  } catch (error: unknown) {
    errors.push(`list-repositories: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Head pre-check walks the full ordered candidate list until maxPollsPerRun repositories actually
  // NEED a container - a repository skipped for an unchanged head must not consume a poll slot.
  const liveness = new Map<string, RepositoryLivenessUpdate>();
  const livenessFor = (repository: string): RepositoryLivenessUpdate => {
    let u = liveness.get(repository);
    if (!u) {
      u = { repository, headCheckAt: deps.now().toISOString(), headChanged: false, headCheckFailed: false, pollAttempted: false, pollSucceeded: false };
      liveness.set(repository, u);
    }
    return u;
  };

  // Head checks are NEVER gated by the launch ceiling. They are one cheap GitHub call, and suppressing
  // them would make a repository whose head moved look idle - destroying both the liveness signal and the
  // missed-commit measurement. The ceiling belongs immediately before a CONTAINER LAUNCH, below.
  const changedNeedingAnalysis: PollableRepository[] = [];
  let headChecksDone = 0;
  for (const repo of candidates) {
    if (headChecksDone >= config.maxHeadChecksPerRun) break;
    headChecksDone++;
    const live = livenessFor(repo.repository);
    if (repo.lastPolledSha) {
      try {
        const head = await deps.fetchRemoteHead(repo.repository);
        if (head && "gone" in head) {
          live.headCheckFailed = true;
          errors.push(`${repo.repository}: remote head check says repository is gone (${head.gone}) - skipped, consider PAUSED`);
          continue;
        }
        if (head) live.observedHeadSha = head.sha;
        if (head && head.sha === repo.lastPolledSha) {
          headChecksSkipped++;
          continue;
        }
        if (head) live.headChanged = true;
      } catch (error: unknown) {
        live.headCheckFailed = true;
        deps.log(`shadow-cron: head pre-check failed for ${repo.repository}, polling anyway: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      live.headChanged = true; // never analysed before
    }
    changedNeedingAnalysis.push(repo);
  }

  // Ceiling applied HERE - at the container launch, not at the observation. One slot is reserved per
  // repository immediately before its container starts, and is never refunded whatever the outcome.
  const wantToLaunch = changedNeedingAnalysis.slice(0, config.maxPollsPerRun);
  const toPoll: PollableRepository[] = [];
  const slotByRepository = new Map<string, number>();
  let launchesAttempted = 0;
  let dailyCeilingRefusals = 0;
  for (const repo of wantToLaunch) {
    launchesAttempted++;
    if (!deps.reserveLaunchSlot) {
      toPoll.push(repo);
      continue;
    }
    const reservation = await deps.reserveLaunchSlot(repo.repository, config.maxPollsPerDay);
    if (!reservation.granted) {
      dailyCeilingRefusals++;
      continue;
    }
    if (typeof reservation.slotNo === "number") slotByRepository.set(repo.repository, reservation.slotNo);
    toPoll.push(repo);
  }
  // Head changes beyond maxPollsPerRun are NOT ceiling refusals - they are simply next sweep's work.
  const deferredToNextSweep = changedNeedingAnalysis.length - wantToLaunch.length;
  if (dailyCeilingRefusals > 0) {
    deps.log(`shadow-cron: ${dailyCeilingRefusals} observed head change(s) refused - daily launch ceiling (${config.maxPollsPerDay}) spent; head checks continue`);
  }
  if (deferredToNextSweep > 0) {
    deps.log(`shadow-cron: ${deferredToNextSweep} observed head change(s) deferred to a later sweep (per-sweep cap ${config.maxPollsPerRun})`);
  }

  // Every detected transition is recorded, analysed or deferred. Overwritten state cannot answer
  // "what did the head used to be?", so the sequence is preserved here for later derivation.
  if (deps.recordHeadTransition) {
    for (const repo of changedNeedingAnalysis) {
      const live = liveness.get(repo.repository);
      const toSha = live?.observedHeadSha;
      if (!toSha) continue;
      try {
        await deps.recordHeadTransition({
          repository: repo.repository,
          fromSha: repo.lastPolledSha,
          toSha,
          detectedAt: deps.now().toISOString(),
          analysed: toPoll.some((r) => r.repository === repo.repository),
        });
      } catch (error: unknown) {
        errors.push(`record-head-transition ${repo.repository}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  for (const repo of toPoll) livenessFor(repo.repository).pollAttempted = true;

  if (toPoll.length > 0) {
    let verified: VerifiedSourceArchive | undefined;
    try {
      verified = await deps.getVerifiedSourceArchive();
    } catch (error: unknown) {
      errors.push(`get-source-archive: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!verified || verified.status !== "CURRENT") {
      sourceIntegrityStatus = verified?.status;
      // Loud, recorded, and non-fatal for reconciliation below - reconcile needs no source archive.
      // Deliberately NOT a poll attempt with a fallback source: a STALE/MISSING/UNKNOWN archive must
      // never silently produce a normal prediction (the 2026-08-21 fix's whole point) - every repository
      // due for polling this run is skipped, exactly like the pre-fix "no archive uploaded at all" case.
      const reason = verified ? `source-integrity-${verified.status}` : "get-source-archive-failed";
      const detail = verified?.detail ?? "getVerifiedSourceArchive threw - see the get-source-archive error above";
      errors.push(`${reason}: ${toPoll.length} repository(ies) due for polling refused - ${detail}`);
    } else {
      sourceIntegrityStatus = verified.status;
      const { file, archiveSha } = verified;
      const results = await Promise.all(
        toPoll.map(async (repo) => {
          try {
            const result = await deps.pollRepository(repo, file, archiveSha);
            return { repo, result };
          } catch (error: unknown) {
            return { repo, error: error instanceof Error ? error.message : String(error) };
          }
        }),
      );
      for (const r of results) {
        const slotNo = slotByRepository.get(r.repo.repository);
        if ("error" in r) {
          launchesFailed++;
          // Explicit refusal: a repository failing persistently is paused rather than left to re-fail
          // every sweep at container cost. Bounded by maxConsecutivePollErrors, and only ever reached
          // after that many CONSECUTIVE failures, since any success resets the counter.
          if (deps.pauseRepository && deps.consecutivePollErrors) {
            try {
              const priorFailures = await deps.consecutivePollErrors(r.repo.repository);
              if (priorFailures + 1 >= config.maxConsecutivePollErrors) {
                const reason = `AUTO_PAUSED after ${priorFailures + 1} consecutive failed polls. Last error: ${String(r.error).slice(0, 200)}`;
                await deps.pauseRepository(r.repo.repository, reason);
                autoPaused.push(r.repo.repository);
                deps.log(`shadow-cron: auto-paused ${r.repo.repository} - ${reason}`);
              }
            } catch (error: unknown) {
              errors.push(`auto-pause ${r.repo.repository}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
          // The slot stays consumed: the container ran and cost real compute even though it failed.
          if (deps.recordLaunchOutcome && typeof slotNo === "number") {
            try {
              await deps.recordLaunchOutcome(slotNo, "failed");
            } catch {
              /* outcome telemetry must never fail a sweep */
            }
          }
          errors.push(`poll ${r.repo.repository}: ${r.error}`);
          continue;
        }
        launchesSucceeded++;
        if (deps.recordLaunchOutcome && typeof slotNo === "number") {
          try {
            await deps.recordLaunchOutcome(slotNo, "succeeded");
          } catch {
            /* outcome telemetry must never fail a sweep */
          }
        }
        reposPolled.push(r.repo.repository);
        livenessFor(r.repo.repository).pollSucceeded = true;
        predictionsRecorded += r.result.predictionsRecorded;
        errors.push(...r.result.errors.map((e) => `poll ${r.repo.repository}: ${e}`));
      }
    }
  }

  // Reconcile every reconcilable repository (not only the ones polled this run) - ground truth for an
  // earlier prediction can complete while the head hasn't moved since, and webhook-enrolled
  // repositories need this sweep as their missed-delivery safety net.
  let reconcilable: PollableRepository[] = [];
  try {
    reconcilable = await deps.listReconcilableRepositories();
  } catch (error: unknown) {
    errors.push(`list-reconcilable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const toReconcile = reconcilable.slice(0, config.maxReconcilesPerRun);
  const reconcileResults = await Promise.all(
    toReconcile.map(async (repo) => {
      try {
        return { repo, result: await deps.reconcileRepository(repo.repository) };
      } catch (error: unknown) {
        return { repo, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
  for (const r of reconcileResults) {
    if ("error" in r) {
      errors.push(`reconcile ${r.repo.repository}: ${r.error}`);
      continue;
    }
    reposReconciled++;
    groundTruthReconciled += r.result.reconciled;
    stillPending += r.result.stillPending;
    errors.push(...r.result.errors.map((e) => `reconcile ${r.repo.repository}: ${e}`));
  }

  if (deps.recordRepositoryLiveness && liveness.size > 0) {
    try {
      await deps.recordRepositoryLiveness([...liveness.values()]);
    } catch (error: unknown) {
      // Telemetry must never take down observation itself.
      errors.push(`record-liveness: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const record: ShadowCronRunRecord = {
    startedAt,
    finishedAt: deps.now().toISOString(),
    trigger,
    reposConsidered: candidates.length,
    headChecksSkipped,
    reposPolled,
    predictionsRecorded,
    reposReconciled,
    groundTruthReconciled,
    stillPending,
    errors,
    dailyCeilingRefusals,
    headTransitionsDetected: changedNeedingAnalysis.length,
    autoPaused,
    launchesAttempted,
    launchesAllowed: toPoll.length,
    launchesSucceeded,
    launchesFailed,
    sourceIntegrityStatus,
  };

  try {
    await deps.recordCronRun(record);
  } catch (error: unknown) {
    // The run itself succeeded - a telemetry write failure must not fail the invocation, but it must
    // be visible in logs (observability is enabled on this Worker).
    deps.log(`shadow-cron: failed to record cron run telemetry: ${error instanceof Error ? error.message : String(error)}`);
  }

  deps.log(
    `shadow-cron (${trigger}): considered=${record.reposConsidered} skipped-unchanged=${headChecksSkipped} polled=[${reposPolled.join(",")}] predictions=${predictionsRecorded} reconciled=${groundTruthReconciled} pending=${stillPending} sourceIntegrity=${sourceIntegrityStatus ?? "not-checked"} errors=${errors.length}`,
  );
  return record;
}
