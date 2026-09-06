/**
 * Stage-economics capture sweep on ADMITTED evidence only (2026-09-05, measurement-integrity repair
 * step 3). Successor of shadow-economics-job.ts, which is no longer scheduled.
 *
 * Per repository, per sweep: the VERIFIED ground-truth rows in the window that have no stage rows yet
 * (read through the sanctioned ShadowReadBoundary), the repository's explicit stage classification, one
 * GitHub call per admitted prediction for the jobs of THAT row's evidence run (never "any completed
 * run"), classification with provenance, one row per stage. Round-robin across repositories so one
 * busy repository cannot spend the whole budget (the same live fairness bug the legacy sweep hit on
 * 2026-08-25). Never writes to shadow_predictions / shadow_ground_truth.
 */
import type { ShadowReadBoundary } from "../product/shadow-read-boundary.js";
import type { ShadowStageEconomicsStore } from "./shadow-stage-economics-store.js";
import { deriveStageEconomics } from "./shadow-stage-economics.js";
import { fetchRunJobs } from "../shadow/github-baseline.js";
import type { BaselineJobInfo } from "../shadow/types.js";
import type { StageClassificationConfig } from "../shadow/stage-classification-config.js";

export interface StageEconomicsJobDeps {
  shadowBoundary: ShadowReadBoundary;
  store: ShadowStageEconomicsStore;
  /** The repository's explicit classification, or undefined for conservative inference. */
  resolveClassification: (repository: string) => Promise<StageClassificationConfig | undefined>;
  /** Injectable for tests; defaults to the real GitHub jobs call. */
  fetchJobs?: (repository: string, runId: string, token?: string) => Promise<BaselineJobInfo[]>;
  resolveToken?: (repository: string) => Promise<string | undefined>;
  nowIso?: () => string;
  /** 2026-09-05 seamless install: for an automatically derived classification, the executed run must
   * match the derived job/step shape before any economics row is written. Returns ok:true for explicit
   * configurations. A mismatch is recorded by the implementation (the repository returns to awaiting). */
  verifyDerivation?: (repository: string, jobs: readonly BaselineJobInfo[]) => Promise<{ ok: boolean; detail?: string }>;
  /** 2026-09-06 manual trigger: restrict the sweep to one enrolled repository. Absent = every enrolled
   * repository, as the cron runs it. A repository not enrolled is simply not considered. */
  onlyRepository?: string;
}

export interface StageEconomicsJobResult {
  repositoriesConsidered: number;
  predictionsAttempted: number;
  stageRowsCaptured: number;
  skippedAlreadyRecorded: number;
  skippedNoDerivableRows: number;
  unconfiguredRepositories: string[];
  derivationMismatches: number;
  fetchErrors: number;
  errors: number;
  repositoriesAttempted: string[];
}

export async function runStageEconomicsCaptureSweep(deps: StageEconomicsJobDeps, windowStartIso: string, windowEndIso: string, maxPerSweep: number): Promise<StageEconomicsJobResult> {
  const fetchJobs = deps.fetchJobs ?? fetchRunJobs;
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const result: StageEconomicsJobResult = {
    repositoriesConsidered: 0,
    predictionsAttempted: 0,
    stageRowsCaptured: 0,
    skippedAlreadyRecorded: 0,
    skippedNoDerivableRows: 0,
    unconfiguredRepositories: [],
    derivationMismatches: 0,
    fetchErrors: 0,
    errors: 0,
    repositoriesAttempted: [],
  };
  const enrolled = await deps.shadowBoundary.listEnrolledRepositories();
  const repositories = deps.onlyRepository ? enrolled.filter((r) => r === deps.onlyRepository) : enrolled;
  result.repositoriesConsidered = repositories.length;

  type Queue = { repository: string; rows: Awaited<ReturnType<ShadowReadBoundary["listVerifiedGroundTruth"]>>; index: number; token?: string; config?: StageClassificationConfig };
  const queues: Queue[] = [];
  for (const repository of repositories) {
    const verified = await deps.shadowBoundary.listVerifiedGroundTruth(repository, windowStartIso, windowEndIso);
    if (verified.length === 0) continue;
    const recorded = new Set(await deps.store.listRecordedDeltaKeys(repository));
    const rows = verified.filter((r) => !recorded.has(r.logicalDeltaKey));
    result.skippedAlreadyRecorded += verified.length - rows.length;
    if (rows.length === 0) continue;
    const config = await deps.resolveClassification(repository);
    if (!config) result.unconfiguredRepositories.push(repository);
    const token = deps.resolveToken ? await deps.resolveToken(repository) : undefined;
    queues.push({ repository, rows, index: 0, token, config });
  }

  for (;;) {
    let progressed = false;
    for (const queue of queues) {
      if (result.predictionsAttempted >= maxPerSweep) break;
      if (queue.index >= queue.rows.length) continue;
      progressed = true;
      const row = queue.rows[queue.index]!;
      queue.index++;
      result.predictionsAttempted++;
      if (!result.repositoriesAttempted.includes(queue.repository)) result.repositoriesAttempted.push(queue.repository);
      let jobs: BaselineJobInfo[];
      try {
        jobs = await fetchJobs(queue.repository, row.evidenceRunId, queue.token);
      } catch {
        result.fetchErrors++;
        continue;
      }
      if (deps.verifyDerivation && queue.config) {
        const v = await deps.verifyDerivation(queue.repository, jobs);
        if (!v.ok) {
          result.derivationMismatches++;
          continue; // never classify against a shape the executed run does not have
        }
      }
      try {
        const observations = deriveStageEconomics(
          {
            logicalDeltaKey: row.logicalDeltaKey,
            repository: row.repository,
            headSha: row.headSha,
            testsSelectedDiffci: row.testsSelectedDiffci,
            testsTotalFull: row.testsTotalFull,
            testsSelectedPath: row.testsSelectedPath,
            planMode: row.planMode,
            diffciAnalysisOverheadMs: row.diffciAnalysisOverheadMs,
          },
          { workflowRunId: Number(row.evidenceRunId), workflowPath: row.evidenceWorkflowPath },
          jobs,
          queue.config,
          nowIso(),
        );
        if (observations.length === 0) {
          result.skippedNoDerivableRows++;
          continue;
        }
        for (const o of observations) {
          if (await deps.store.recordIfNew(o)) result.stageRowsCaptured++;
        }
      } catch {
        result.errors++;
      }
    }
    if (!progressed || result.predictionsAttempted >= maxPerSweep) break;
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------
// Manual trigger (2026-09-06). The cron sweeps every 10 minutes with a cap of 10 predictions; a founder
// who has just configured or re-identified a repository should not have to wait for ticks to see
// whether economics rows appear. The request is parsed here, pure and tested; the Worker runs the same
// sweep function the cron does.
// ---------------------------------------------------------------------------------------------------

export interface StageSweepOptions {
  /** One enrolled repository, or every enrolled repository when absent. */
  onlyRepository?: string;
  /** Upper bound on predictions attempted - one GitHub jobs call each. */
  maxPerSweep: number;
  /** Rolling window of prediction time considered, in days. */
  windowDays: number;
}

export const STAGE_SWEEP_LIMITS = { defaultMax: 10, maxMax: 50, defaultDays: 30, maxDays: 90 } as const;

export function parseStageSweepRequest(params: { get(name: string): string | null }): { ok: true; options: StageSweepOptions } | { ok: false; error: string } {
  const repository = params.get("repository");
  // A GitHub owner is alphanumerics and hyphens (no leading hyphen); a repository name may carry dots
  // but is never "." or "..". Written out so "../x" cannot pass as an owner.
  if (repository !== null && !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/.test(repository)) return { ok: false, error: "repository must be 'owner/name'" };
  const maxRaw = params.get("max");
  const maxPerSweep = maxRaw === null ? STAGE_SWEEP_LIMITS.defaultMax : Number.parseInt(maxRaw, 10);
  if (!Number.isInteger(maxPerSweep) || maxPerSweep < 1 || maxPerSweep > STAGE_SWEEP_LIMITS.maxMax) return { ok: false, error: `max must be an integer from 1 to ${STAGE_SWEEP_LIMITS.maxMax}` };
  const daysRaw = params.get("days");
  const windowDays = daysRaw === null ? STAGE_SWEEP_LIMITS.defaultDays : Number.parseInt(daysRaw, 10);
  if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > STAGE_SWEEP_LIMITS.maxDays) return { ok: false, error: `days must be an integer from 1 to ${STAGE_SWEEP_LIMITS.maxDays}` };
  return { ok: true, options: { onlyRepository: repository ?? undefined, maxPerSweep, windowDays } };
}
