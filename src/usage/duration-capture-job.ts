/**
 * The "isolated process" half of real duration capture: reads recent Stage 2F predictions ONLY through
 * the existing, already-sanctioned read-only ShadowReadBoundary (Part 20 - never new/raw SQL against
 * shadow_predictions/shadow_ground_truth, never a write), independently re-fetches real GitHub Actions
 * job timing for each one via src/shadow/github-baseline.ts's fetchBaselineEvidence (also read-only,
 * imported unmodified - this module makes zero changes to Stage 2F's frozen code or schema), and stores
 * whatever it can honestly derive into the separate, additive ci_duration_observations table.
 *
 * Deliberately small and forgiving: a batch cap keeps each sweep well under GitHub's unauthenticated rate
 * limit (60 req/hour/IP - this job passes no token, same default fetchBaselineEvidence already supports),
 * and any single commit's fetch failing (rate limit, network, CI not yet complete) just means that one
 * commit is skipped this sweep - never retried in a tight loop, never blocks the rest of the batch.
 */
import type { ShadowReadBoundary } from "../product/shadow-read-boundary.js";
import type { DurationObservationStore } from "./duration-observation-store.js";
import { deriveDurationObservation } from "./duration-capture.js";
import { fetchBaselineEvidence, type FetchBaselineOptions } from "../shadow/github-baseline.js";

export interface DurationCaptureJobDeps {
  shadowBoundary: ShadowReadBoundary;
  store: DurationObservationStore;
  /** Injectable for tests; defaults to the real fetchBaselineEvidence against the real GitHub API. */
  fetchBaseline?: (options: FetchBaselineOptions) => ReturnType<typeof fetchBaselineEvidence>;
  nowIso?: () => string;
}

export interface DurationCaptureJobResult {
  attempted: number;
  captured: number;
  skippedIncomplete: number;
  alreadyRecorded: number;
  errors: number;
}

/**
 * `repositories` are the product's own enrolled repositories (from ProductStore, NOT shadow_repositories
 * - this job never queries Stage 2F's repository table either). `windowStartIso`/`windowEndIso` bound
 * which predictions are candidates; `maxPerSweep` caps real GitHub API calls made in one invocation.
 */
export async function runDurationCaptureSweep(
  deps: DurationCaptureJobDeps,
  repositories: string[],
  windowStartIso: string,
  windowEndIso: string,
  maxPerSweep: number,
): Promise<DurationCaptureJobResult> {
  const fetchBaseline = deps.fetchBaseline ?? fetchBaselineEvidence;
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const result: DurationCaptureJobResult = { attempted: 0, captured: 0, skippedIncomplete: 0, alreadyRecorded: 0, errors: 0 };

  for (const repository of repositories) {
    if (result.attempted >= maxPerSweep) break;
    const predictions = await deps.shadowBoundary.listPredictions(repository, windowStartIso, windowEndIso);

    for (const prediction of predictions) {
      if (result.attempted >= maxPerSweep) break;
      result.attempted++;

      let evidence;
      try {
        evidence = await fetchBaseline({ repository: prediction.repository, headSha: prediction.headSha });
      } catch {
        result.errors++;
        continue;
      }

      if (evidence.status !== "COMPLETE" || typeof evidence.baselineDurationMs !== "number") {
        result.skippedIncomplete++;
        continue;
      }

      const observation = deriveDurationObservation(
        { logicalDeltaKey: prediction.logicalDeltaKey, repository: prediction.repository, headSha: prediction.headSha, testsTotalFull: prediction.testsTotalFull },
        evidence.baselineDurationMs,
        evidence.fullRunsObserved.map((r) => r.workflowRunId),
        evidence.jobs.map((j) => j.jobId),
        nowIso(),
      );
      if (!observation) {
        result.skippedIncomplete++;
        continue;
      }

      const wasNew = await deps.store.recordIfNew(observation);
      if (wasNew) result.captured++;
      else result.alreadyRecorded++;
    }
  }

  return result;
}
