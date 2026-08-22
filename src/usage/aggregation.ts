/**
 * Usage aggregation (Part 7) - pure domain logic, reusable from the product API, a dashboard BFF, or a
 * future billing-invoice job alike. Deliberately NOT computed inline inside an HTTP handler (Part 7:
 * "Do not compute billing-critical metrics only in HTTP handlers").
 */
import type { Entitlements } from "../billing/types.js";
import type { UsageStore } from "./store.js";
import type { UsageSummary } from "./types.js";

export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function startOfUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

export function endOfUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
}

export async function summarizeUsage(store: UsageStore, organizationId: string, periodStart: Date, periodEnd: Date): Promise<UsageSummary> {
  const startIso = periodStart.toISOString();
  const endIso = periodEnd.toISOString();
  const [predictions, ciRunsAnalyzed, testsConsidered, testsSelected, estimatedComputeSeconds, runnerSeconds, runnerJobs, activeRepositories] = await Promise.all([
    store.sumQuantityInRange(organizationId, "prediction", startIso, endIso),
    store.sumQuantityInRange(organizationId, "ci_run_analyzed", startIso, endIso),
    store.sumQuantityInRange(organizationId, "tests_considered", startIso, endIso),
    store.sumQuantityInRange(organizationId, "tests_selected", startIso, endIso),
    store.sumQuantityInRange(organizationId, "estimated_compute_seconds", startIso, endIso),
    store.sumQuantityInRange(organizationId, "runner_seconds", startIso, endIso),
    store.sumQuantityInRange(organizationId, "runner_job", startIso, endIso),
    store.countDistinctActiveRepositories(organizationId, startIso, endIso),
  ]);
  return {
    organizationId,
    periodStart: startIso,
    periodEnd: endIso,
    ciRunsAnalyzed,
    predictions,
    testsConsidered,
    testsSelected,
    estimatedComputeSeconds,
    runnerSeconds,
    runnerJobs,
    activeRepositories,
  };
}

export interface AllowanceStatus {
  planAllowance: number; // -1 means unlimited
  used: number;
  remaining: number; // Infinity if unlimited
  percentConsumed: number; // 0-100, 0 if unlimited
}

/** "CI analysis" for allowance purposes is counted as ci_run_analyzed - the number of times DiffCI
 * actually ran an analysis for a commit, matching the plan's monthlyAnalysisAllowance semantics
 * (src/billing/plans.ts). */
export function computeAllowanceStatus(entitlements: Entitlements, ciRunsAnalyzedThisMonth: number): AllowanceStatus {
  if (entitlements.monthlyAnalysisAllowance < 0) {
    return { planAllowance: -1, used: ciRunsAnalyzedThisMonth, remaining: Infinity, percentConsumed: 0 };
  }
  const remaining = Math.max(0, entitlements.monthlyAnalysisAllowance - ciRunsAnalyzedThisMonth);
  const percentConsumed = entitlements.monthlyAnalysisAllowance === 0 ? 100 : Math.min(100, (ciRunsAnalyzedThisMonth / entitlements.monthlyAnalysisAllowance) * 100);
  return { planAllowance: entitlements.monthlyAnalysisAllowance, used: ciRunsAnalyzedThisMonth, remaining, percentConsumed };
}
