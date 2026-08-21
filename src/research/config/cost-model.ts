/**
 * Stage 0 budget accounting.
 *
 * Verified against live Cloudflare pricing docs on 2026-08-20 (Workers Standard/Workflows/D1/R2/Queues
 * pricing pages). See diffci/docs/research/2026-08-20-stage0-full-experiment-architecture.md §1/§3 for
 * the sourcing and the rationale behind the three-way measured/estimated/projected split.
 *
 * "1 credit == $1 of Cloudflare spend" per the approved experiment design. The 2,000-credit ceiling is
 * a safety rail, not a number this experiment is expected to approach in normal operation - see the
 * architecture doc for the back-of-envelope full-run estimate.
 *
 * Container pricing added 2026-08-21 for the full-Stage-0 orchestrator: the original design assumed a
 * Workflows-based execution model, but the actual implementation runs analysis inside Cloudflare
 * Containers (see the 2026-08-20 cloud-validation report for why - plain Workers/Workflows have no
 * filesystem/subprocess capability), a materially different, previously-uncounted billing dimension.
 * Verified against the live Containers pricing page (Workers Platform pricing, "Containers" section)
 * 2026-08-21: active-CPU-second billing (not provisioned-capacity billing), separate memory and disk
 * dimensions. Deliberately NOT netting out the included free monthly allowances (25 GiB-hours memory,
 * 375 vCPU-minutes, 200 GB-hours disk) - conservative accounting bills every unit at the marginal rate,
 * since the free tier is account-wide and shared with unrelated usage, not something this experiment
 * should assume it can claim exclusively.
 */

/** Real, published Cloudflare per-unit prices (USD). Do not multiply anything by a placeholder here -
 * every constant below is directly sourced from a pricing page, cited in the architecture doc. */
export const CLOUDFLARE_UNIT_PRICES_USD = {
  /** Workers/Workflows requests, $0.30 / 1,000,000. */
  requestPerUnit: 0.3 / 1_000_000,
  /** Workers/Workflows CPU time, $0.02 / 1,000,000 CPU-ms. */
  cpuMsPerUnit: 0.02 / 1_000_000,
  /** Workflow steps, $0.80 / 100,000. */
  workflowStepPerUnit: 0.8 / 100_000,
  /** Workflow persisted state, $0.20 / GB-month. */
  workflowStorageGbMonth: 0.2,
  /** D1 rows read, $0.001 / 1,000,000 rows. */
  d1RowReadPerUnit: 0.001 / 1_000_000,
  /** D1 rows written, $1.00 / 1,000,000 rows. */
  d1RowWritePerUnit: 1.0 / 1_000_000,
  /** D1 storage, $0.75 / GB-month. */
  d1StorageGbMonth: 0.75,
  /** R2 storage (Standard), $0.015 / GB-month. */
  r2StorageGbMonth: 0.015,
  /** R2 Class A operations (writes/mutations), $4.50 / 1,000,000. */
  r2ClassAPerUnit: 4.5 / 1_000_000,
  /** R2 Class B operations (reads), $0.36 / 1,000,000. */
  r2ClassBPerUnit: 0.36 / 1_000_000,
  /** Queues operations (read+write+delete, per 64KB chunk), $0.40 / 1,000,000. */
  queueOperationPerUnit: 0.4 / 1_000_000,
  /** Container active CPU time, $0.000020 / vCPU-second (active use only, not provisioned capacity). */
  containerVcpuSecond: 0.00002,
  /** Container provisioned memory, $0.0000025 / GiB-second. */
  containerMemoryGibSecond: 0.0000025,
  /** Container provisioned disk, $0.00000007 / GB-second. */
  containerDiskGbSecond: 0.00000007,
} as const;

/** Exact counts of billable operations our own code performed. Every field here is something we
 * control and can count precisely - multiplying these by CLOUDFLARE_UNIT_PRICES_USD produces
 * "measured" spend, as close to real billing as is obtainable without a live GraphQL Analytics API
 * pull (which lags). Never merge this with estimatedCpuMs - see computeSpend(). */
export interface UsageCounters {
  workerRequests: number;
  workflowSteps: number;
  workflowStorageGbMonths: number;
  d1RowsRead: number;
  d1RowsWritten: number;
  d1StorageGbMonths: number;
  r2ClassAOps: number;
  r2ClassBOps: number;
  r2StorageGbMonths: number;
  queueOperations: number;
  /** Wall-clock container-active seconds observed (Worker-side timing around exec calls) x the
   * container's provisioned vCPU count (standard-2 = 1 vCPU for this experiment's Sandbox config).
   * This is the dominant real cost driver for the full experiment, unlike the Workflow-era fields
   * above which stay at effectively zero since no Workflow is actually used. */
  containerVcpuSeconds: number;
  containerMemoryGibSeconds: number;
  containerDiskGbSeconds: number;
}

export function zeroUsageCounters(): UsageCounters {
  return {
    workerRequests: 0,
    workflowSteps: 0,
    workflowStorageGbMonths: 0,
    d1RowsRead: 0,
    d1RowsWritten: 0,
    d1StorageGbMonths: 0,
    containerVcpuSeconds: 0,
    containerMemoryGibSeconds: 0,
    containerDiskGbSeconds: 0,
    r2ClassAOps: 0,
    r2ClassBOps: 0,
    r2StorageGbMonths: 0,
    queueOperations: 0,
  };
}

export function addUsageCounters(a: UsageCounters, b: Partial<UsageCounters>): UsageCounters {
  return {
    workerRequests: a.workerRequests + (b.workerRequests ?? 0),
    workflowSteps: a.workflowSteps + (b.workflowSteps ?? 0),
    workflowStorageGbMonths: a.workflowStorageGbMonths + (b.workflowStorageGbMonths ?? 0),
    d1RowsRead: a.d1RowsRead + (b.d1RowsRead ?? 0),
    d1RowsWritten: a.d1RowsWritten + (b.d1RowsWritten ?? 0),
    d1StorageGbMonths: a.d1StorageGbMonths + (b.d1StorageGbMonths ?? 0),
    containerVcpuSeconds: a.containerVcpuSeconds + (b.containerVcpuSeconds ?? 0),
    containerMemoryGibSeconds: a.containerMemoryGibSeconds + (b.containerMemoryGibSeconds ?? 0),
    containerDiskGbSeconds: a.containerDiskGbSeconds + (b.containerDiskGbSeconds ?? 0),
    r2ClassAOps: a.r2ClassAOps + (b.r2ClassAOps ?? 0),
    r2ClassBOps: a.r2ClassBOps + (b.r2ClassBOps ?? 0),
    r2StorageGbMonths: a.r2StorageGbMonths + (b.r2StorageGbMonths ?? 0),
    queueOperations: a.queueOperations + (b.queueOperations ?? 0),
  };
}

/** measuredUsd = exact operation counts x real published rates (§1 of the architecture doc).
 * estimatedUsd = CPU-ms, which the Workers/Workflows runtime does not expose a readback API for; this
 * uses wall-clock timing our own code already captures as a conservative (over-, not under-) estimate.
 * These two are returned separately and must never be silently merged into one "the" number - every
 * caller that surfaces spend must label which of the two (or their sum) it is showing. */
export interface SpendBreakdown {
  measuredUsd: number;
  estimatedUsd: number;
  totalUsd: number;
}

export function computeMeasuredUsd(counters: UsageCounters): number {
  const p = CLOUDFLARE_UNIT_PRICES_USD;
  return (
    counters.workerRequests * p.requestPerUnit +
    counters.workflowSteps * p.workflowStepPerUnit +
    counters.workflowStorageGbMonths * p.workflowStorageGbMonth +
    counters.d1RowsRead * p.d1RowReadPerUnit +
    counters.d1RowsWritten * p.d1RowWritePerUnit +
    counters.d1StorageGbMonths * p.d1StorageGbMonth +
    counters.containerVcpuSeconds * p.containerVcpuSecond +
    counters.containerMemoryGibSeconds * p.containerMemoryGibSecond +
    counters.containerDiskGbSeconds * p.containerDiskGbSecond +
    counters.r2ClassAOps * p.r2ClassAPerUnit +
    counters.r2ClassBOps * p.r2ClassBPerUnit +
    counters.r2StorageGbMonths * p.r2StorageGbMonth +
    counters.queueOperations * p.queueOperationPerUnit
  );
}

export function computeEstimatedUsd(estimatedCpuMs: number): number {
  return estimatedCpuMs * CLOUDFLARE_UNIT_PRICES_USD.cpuMsPerUnit;
}

export function computeSpend(counters: UsageCounters, estimatedCpuMs: number): SpendBreakdown {
  const measuredUsd = computeMeasuredUsd(counters);
  const estimatedUsd = computeEstimatedUsd(estimatedCpuMs);
  return { measuredUsd, estimatedUsd, totalUsd: measuredUsd + estimatedUsd };
}

/** 1 credit == $1, per the approved experiment design. Kept as a named conversion (not inlined) so a
 * future re-pricing only touches this one function, and so it's never silently invented elsewhere. */
export function usdToCredits(usd: number): number {
  return usd;
}

export const BUDGET_CREDIT_CEILING = 2000;
export const BUDGET_WARNING_THRESHOLD = 1600;
export const BUDGET_RESERVE_THRESHOLD = 1850;
export const BUDGET_HARD_STOP_THRESHOLD = 1950;

export type BudgetStatus = "OK" | "WARNING" | "RESERVE" | "BUDGET_STOPPED";

export interface BudgetEvaluation {
  status: BudgetStatus;
  spentCredits: number;
  remainingCredits: number;
  /** True once spend crosses BUDGET_HARD_STOP_THRESHOLD - callers must not start any further
   * expensive operation (new repository, new delta batch) once this is true. */
  mustStop: boolean;
  /** True once spend crosses BUDGET_RESERVE_THRESHOLD - callers should not start NEW low-priority
   * work but may let already-running work finish/checkpoint. */
  reserveMode: boolean;
}

/** Evaluates budget status from cumulative spend (measured + estimated, in USD == credits). Pure
 * function so it's trivially unit-testable against the exact tier boundaries the task specifies. */
export function evaluateBudgetStatus(cumulativeSpendUsd: number): BudgetEvaluation {
  const spentCredits = usdToCredits(cumulativeSpendUsd);
  const remainingCredits = Math.max(0, BUDGET_CREDIT_CEILING - spentCredits);
  let status: BudgetStatus = "OK";
  if (spentCredits >= BUDGET_HARD_STOP_THRESHOLD) status = "BUDGET_STOPPED";
  else if (spentCredits >= BUDGET_RESERVE_THRESHOLD) status = "RESERVE";
  else if (spentCredits > BUDGET_WARNING_THRESHOLD) status = "WARNING";
  return {
    status,
    spentCredits,
    remainingCredits,
    mustStop: status === "BUDGET_STOPPED",
    reserveMode: status === "RESERVE" || status === "BUDGET_STOPPED",
  };
}

/** Conservative projection used before starting a new unit of work (a repository, or a delta batch):
 * given spend-so-far and progress-so-far, project the total spend if `unitsRemaining` more units of
 * average cost are completed. Used to decide whether starting the NEXT unit is safe under RESERVE mode
 * ("do not begin low-priority/new repository work unless projected cost safely fits"), not to predict
 * the final report number precisely. */
export function projectRemainingSpendUsd(spentUsdSoFar: number, unitsCompleted: number, unitsRemaining: number): number {
  if (unitsCompleted <= 0) return 0;
  const avgPerUnit = spentUsdSoFar / unitsCompleted;
  return avgPerUnit * unitsRemaining;
}

/** Before starting a new unit of work while in RESERVE mode: is it conservatively safe? A 20% margin
 * is applied on top of the raw projection since average-so-far can understate a harder unit ahead
 * (e.g. a larger, more expensive repository later in the corpus). */
export function isSafeToStartUnderReserve(cumulativeSpendUsd: number, projectedUnitCostUsd: number): boolean {
  const margin = 1.2;
  return usdToCredits(cumulativeSpendUsd + projectedUnitCostUsd * margin) < BUDGET_HARD_STOP_THRESHOLD;
}
