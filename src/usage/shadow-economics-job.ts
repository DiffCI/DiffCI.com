/**
 * The "isolated process" half of shadow-economics capture (External Shadow Pilot M1, 2026-08-25) - reads
 * SHADOW_ACTIVE/SHADOW_LIMITED repositories and their recent predictions ONLY through the existing,
 * already-sanctioned read-only ShadowReadBoundary (never new/raw SQL against shadow_predictions/
 * shadow_ground_truth, never a write), independently re-fetches real GitHub Actions job timing for each
 * one via the SAME fetchBaselineEvidence duration-capture-job.ts already uses (unmodified, read-only,
 * imported verbatim), buckets the real jobs by CI stage, and stores whatever it can honestly derive into
 * the separate, additive shadow_economics_observations table.
 *
 * Deliberately a SEPARATE sweep from duration-capture-job.ts's own (not a shared/merged one), even though
 * both call fetchBaselineEvidence for overlapping commits - matches this codebase's own established
 * precedent (duration-capture-job.ts's own header: "independently re-fetch... without needing any other
 * source") of keeping each subsystem's capture path independently owned and independently forgiving,
 * rather than coupling two different concerns (uniform historical duration vs. stage-aware economics)
 * into one write path. The extra API cost is bounded by the same maxPerSweep discipline duration-capture-
 * job.ts already uses.
 */
import type { ShadowReadBoundary } from "../product/shadow-read-boundary.js";
import type { ShadowEconomicsStore } from "./shadow-economics-store.js";
import { deriveShadowEconomicsObservations, computeHistoricalTestSecondsPerTest } from "./shadow-economics.js";
import { fetchBaselineEvidence, type FetchBaselineOptions } from "../shadow/github-baseline.js";

export interface ShadowEconomicsJobDeps {
  shadowBoundary: ShadowReadBoundary;
  store: ShadowEconomicsStore;
  /** Injectable for tests; defaults to the real fetchBaselineEvidence against the real GitHub API. */
  fetchBaseline?: (options: FetchBaselineOptions) => ReturnType<typeof fetchBaselineEvidence>;
  /**
   * Per-repository GitHub credential, resolved ONCE per repository per sweep (not per prediction - an
   * installation-token exchange is itself an API call). Wired in production to validation-worker.ts's
   * githubTokenForRepo, which mints a least-privilege App installation token for repositories that
   * actually installed the Shadow App and falls back to GITHUB_TOKEN for public repositories observed by
   * poll only.
   *
   * Omitting this is what broke the first live deployment (2026-08-25): unauthenticated GitHub reads get
   * 60 req/hour per IP, and Cloudflare Workers egress from IPs shared across tenants, so that budget is
   * effectively always spent. The failure was invisible because fetchBaselineEvidence reports an API
   * error as status "UNAVAILABLE" - identical to "this commit's CI simply has not finished" - which is
   * why skippedFetchError exists as its own counter below.
   */
  resolveToken?: (repository: string) => Promise<string | undefined>;
  nowIso?: () => string;
}

export interface ShadowEconomicsJobResult {
  repositoriesConsidered: number;
  predictionsAttempted: number;
  stageRowsCaptured: number;
  stageRowsAlreadyRecorded: number;
  /** Total skips, kept as the single headline number. ALWAYS equals the three fields below summed. */
  skippedIncomplete: number;
  errors: number;
  /** GitHub returned an error for this commit (rate limit, 403, network) - fetchBaselineEvidence swallows
   * these into status:"UNAVAILABLE" with a fetchError set, which is indistinguishable from "CI is still
   * running" unless split out here. Found the hard way 2026-08-25: a live sweep reporting
   * skippedIncomplete:5 was completely undiagnosable, because that one number could mean an API outage, a
   * genuinely-pending CI run, or a derive that produced nothing - three problems with three different fixes. */
  skippedFetchError: number;
  /** CI genuinely has no completed non-shadow run for this commit yet (the expected, healthy skip). */
  skippedCiPending: number;
  /** Evidence was COMPLETE but no stage bucket had usable timing - nothing honest to record. */
  skippedNoDerivableRows: number;
  /** Which repositories actually got at least one prediction attempted this sweep. Directly answers
   * "did the budget reach the repositories I care about, or did one repo starve the rest?" - the
   * round-robin fairness fix above is only observable through this field. */
  repositoriesAttempted: string[];
}

/**
 * `windowStartIso`/`windowEndIso` bound which predictions are candidates; `maxPerSweep` caps real GitHub
 * API calls (one fetchBaselineEvidence call per commit, itself potentially several real HTTP requests) -
 * same discipline as duration-capture-job.ts, comfortably under GitHub's unauthenticated rate limit at the
 * existing cron cadence.
 */
export async function runShadowEconomicsCaptureSweep(deps: ShadowEconomicsJobDeps, windowStartIso: string, windowEndIso: string, maxPerSweep: number): Promise<ShadowEconomicsJobResult> {
  const fetchBaseline = deps.fetchBaseline ?? fetchBaselineEvidence;
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const result: ShadowEconomicsJobResult = {
    repositoriesConsidered: 0,
    predictionsAttempted: 0,
    stageRowsCaptured: 0,
    stageRowsAlreadyRecorded: 0,
    skippedIncomplete: 0,
    errors: 0,
    skippedFetchError: 0,
    skippedCiPending: 0,
    skippedNoDerivableRows: 0,
    repositoriesAttempted: [],
  };

  const repositories = await deps.shadowBoundary.listEnrolledRepositories();
  result.repositoriesConsidered = repositories.length;

  // Round-robin queues, one prediction attempted per repo per round, instead of exhausting maxPerSweep on
  // repositories.listPredictions() one repo at a time. Real bug found live 2026-08-25: with repos visited
  // strictly in listEnrolledRepositories()'s alphabetical order, a single high-volume repo
  // (adityankale190895/DentalPresence.in, 20 in-window predictions) consumed the ENTIRE maxPerSweep budget
  // every tick before the sweep ever reached unjs/h3 (repositoriesConsidered:4, predictionsAttempted:5,
  // stageRowsCaptured:0 - confirmed via `wrangler tail` against the real deployed cron). Fairness across
  // repos matters more here than in duration-capture-job.ts's own identical-shaped loop (that job serves a
  // single DiffCI.com-enrolled repository today, so the starvation case can't yet occur there) - left
  // unmodified rather than touched as part of this fix, since it isn't blocking anything live right now.
  const queues: { repository: string; predictions: Awaited<ReturnType<ShadowReadBoundary["listPredictions"]>>; index: number; token?: string }[] = [];
  for (const repository of repositories) {
    const predictions = await deps.shadowBoundary.listPredictions(repository, windowStartIso, windowEndIso);
    // Skip token resolution entirely for a repository with nothing to do - never spend an
    // installation-token exchange on a repository this sweep will not read.
    if (predictions.length === 0) continue;
    const token = deps.resolveToken ? await deps.resolveToken(repository) : undefined;
    queues.push({ repository, predictions, index: 0, token });
  }

  for (;;) {
    let madeProgress = false;
    for (const queue of queues) {
      if (result.predictionsAttempted >= maxPerSweep) break;
      if (queue.index >= queue.predictions.length) continue;
      madeProgress = true;

      const prediction = queue.predictions[queue.index];
      queue.index++;
      result.predictionsAttempted++;
      if (!result.repositoriesAttempted.includes(queue.repository)) result.repositoriesAttempted.push(queue.repository);

      let evidence;
      try {
        evidence = await fetchBaseline({ repository: prediction.repository, headSha: prediction.headSha, token: queue.token });
      } catch {
        result.errors++;
        continue;
      }

      if (evidence.status !== "COMPLETE") {
        result.skippedIncomplete++;
        // fetchError set == GitHub itself failed us; otherwise CI genuinely has nothing completed yet.
        if (evidence.fetchError) result.skippedFetchError++;
        else result.skippedCiPending++;
        continue;
      }

      // This repository's OWN historical test-stage average, read fresh each prediction so an early
      // capture within the same sweep can inform a later one (deliberately not batched/cached across the
      // whole sweep - simplicity over a marginal API-call saving, and per-prediction correctness matters
      // more than sweep-wide consistency here).
      const history = await deps.store.listTestStageObservations(queue.repository, 30);
      const historicalSecondsPerTest = computeHistoricalTestSecondsPerTest(history.map((o) => ({ fullWorkloadMs: o.fullWorkloadMs, testsTotalFull: o.testsTotalFull })));

      const rows = deriveShadowEconomicsObservations(
        { logicalDeltaKey: prediction.logicalDeltaKey, repository: prediction.repository, headSha: prediction.headSha, testsSelectedDiffci: prediction.testsSelectedDiffci, testsTotalFull: prediction.testsTotalFull },
        evidence.fullRunsObserved,
        evidence.jobs,
        historicalSecondsPerTest,
        nowIso(),
      );

      if (rows.length === 0) {
        result.skippedIncomplete++;
        result.skippedNoDerivableRows++;
        continue;
      }

      for (const row of rows) {
        const wasNew = await deps.store.recordIfNew(row);
        if (wasNew) result.stageRowsCaptured++;
        else result.stageRowsAlreadyRecorded++;
      }
    }
    if (!madeProgress || result.predictionsAttempted >= maxPerSweep) break;
  }

  return result;
}
