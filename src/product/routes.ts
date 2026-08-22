/**
 * Organization-scoped product API route handlers (Part 19), decoupled from the Worker's HTTP layer for
 * the same reason src/billing/checkout.ts and portal.ts are - direct unit-testability of authorization,
 * without a fetch() harness. Every function here takes `requestingUserId` first and checks membership
 * before touching anything else (Part 19: "All organization-scoped routes must verify membership.").
 */
import type { ProductStore } from "./store.js";
import type { ShadowReadBoundary } from "./shadow-read-boundary.js";
import type { RunnerStore } from "../runner/store.js";
import type { ExecutionQueueStore } from "../execution-queue/store.js";
import type { UsageStore } from "../usage/store.js";
import { summarizeUsage, computeAllowanceStatus, startOfUtcMonth, endOfUtcMonth } from "../usage/aggregation.js";
import { getEntitlementsForOrganization } from "../billing/entitlements.js";
import { computeSavingsForPrediction, aggregateSavings, type SavingsOptions } from "../usage/savings.js";
import { buildDashboardContract, buildDashboardOverview, buildDashboardRecentActivity, buildDashboardSafety, buildDashboardUsage, type DashboardContract } from "./dashboard.js";
import type { Organization, Repository } from "./types.js";
import type { Runner } from "../runner/types.js";
import type { QueueItem } from "../execution-queue/types.js";

export interface RouteDeps {
  productStore: ProductStore;
  shadowBoundary: ShadowReadBoundary;
  runnerStore: RunnerStore;
  queueStore: ExecutionQueueStore;
  usageStore: UsageStore;
  savingsOptions?: SavingsOptions;
}

export type RouteOutcome<T> = { ok: true; data: T } | { ok: false; error: "unauthorized" | "not_found" };

async function requireMembership(deps: RouteDeps, organizationId: string, userId: string): Promise<Organization | null> {
  const isMember = await deps.productStore.isMember(organizationId, userId);
  if (!isMember) return null;
  return deps.productStore.getOrganization(organizationId);
}

export async function getOrganizationDetails(deps: RouteDeps, userId: string, organizationId: string): Promise<RouteOutcome<{ organization: Organization; entitlements: ReturnType<typeof getEntitlementsForOrganization> }>> {
  const org = await requireMembership(deps, organizationId, userId);
  if (!org) return { ok: false, error: "unauthorized" };
  return { ok: true, data: { organization: org, entitlements: getEntitlementsForOrganization(org) } };
}

export async function listRepositoriesForOrganization(deps: RouteDeps, userId: string, organizationId: string): Promise<RouteOutcome<Repository[]>> {
  const org = await requireMembership(deps, organizationId, userId);
  if (!org) return { ok: false, error: "unauthorized" };
  return { ok: true, data: await deps.productStore.listRepositories(organizationId) };
}

export async function getUsageSummaryForOrganization(deps: RouteDeps, userId: string, organizationId: string): Promise<RouteOutcome<{ summary: Awaited<ReturnType<typeof summarizeUsage>>; allowance: ReturnType<typeof computeAllowanceStatus> }>> {
  const org = await requireMembership(deps, organizationId, userId);
  if (!org) return { ok: false, error: "unauthorized" };
  const now = new Date();
  const summary = await summarizeUsage(deps.usageStore, organizationId, startOfUtcMonth(now), endOfUtcMonth(now));
  const entitlements = getEntitlementsForOrganization(org);
  return { ok: true, data: { summary, allowance: computeAllowanceStatus(entitlements, summary.ciRunsAnalyzed) } };
}

/** `ownerName` identifies which shadow-observed repository to pull savings evidence for - required
 * because Stage 2F's shadow data has no organization concept of its own (Part 20). A caller passes the
 * product Repository.ownerName it already fetched via listRepositoriesForOrganization. */
export async function getSavingsSummaryForOrganization(deps: RouteDeps, userId: string, organizationId: string, ownerName: string): Promise<RouteOutcome<ReturnType<typeof aggregateSavings>>> {
  const org = await requireMembership(deps, organizationId, userId);
  if (!org) return { ok: false, error: "unauthorized" };
  const now = new Date();
  const predictions = await deps.shadowBoundary.listPredictions(ownerName, startOfUtcMonth(now).toISOString(), endOfUtcMonth(now).toISOString());
  const perPrediction = predictions.map((p) => computeSavingsForPrediction(p, deps.savingsOptions));
  return { ok: true, data: aggregateSavings(perPrediction) };
}

export async function getRunnerStatusForOrganization(deps: RouteDeps, userId: string, organizationId: string, runnerId: string): Promise<RouteOutcome<Runner>> {
  const org = await requireMembership(deps, organizationId, userId);
  if (!org) return { ok: false, error: "unauthorized" };
  // Part 23 "cross-org runner access blocked": scoped lookup, never a bare getRunner(id) that could
  // return a different organization's runner.
  const runner = await deps.runnerStore.getRunnerForOrganization(runnerId, organizationId);
  if (!runner) return { ok: false, error: "not_found" };
  return { ok: true, data: runner };
}

export async function listRecentRunnerJobs(deps: RouteDeps, userId: string, organizationId: string): Promise<RouteOutcome<Runner[]>> {
  const org = await requireMembership(deps, organizationId, userId);
  if (!org) return { ok: false, error: "unauthorized" };
  return { ok: true, data: await deps.runnerStore.listRunnersForOrganization(organizationId) };
}

export async function listRecentQueueItems(deps: RouteDeps, userId: string, organizationId: string): Promise<RouteOutcome<QueueItem[]>> {
  const org = await requireMembership(deps, organizationId, userId);
  if (!org) return { ok: false, error: "unauthorized" };
  return { ok: true, data: await deps.queueStore.listItemsForOrganization(organizationId) };
}

export async function getQueueItemForOrganization(deps: RouteDeps, userId: string, organizationId: string, itemId: string): Promise<RouteOutcome<QueueItem>> {
  const org = await requireMembership(deps, organizationId, userId);
  if (!org) return { ok: false, error: "unauthorized" };
  const item = await deps.queueStore.getItemForOrganization(itemId, organizationId); // Part 23 "cross-org access blocked" for queue items too
  if (!item) return { ok: false, error: "not_found" };
  return { ok: true, data: item };
}

export async function getDashboardForOrganization(deps: RouteDeps, userId: string, organizationId: string): Promise<RouteOutcome<DashboardContract>> {
  const org = await requireMembership(deps, organizationId, userId);
  if (!org) return { ok: false, error: "unauthorized" };

  const now = new Date();
  const repositories = await deps.productStore.listRepositories(organizationId);
  const usageSummary = await summarizeUsage(deps.usageStore, organizationId, startOfUtcMonth(now), endOfUtcMonth(now));
  const entitlements = getEntitlementsForOrganization(org);
  const allowance = computeAllowanceStatus(entitlements, usageSummary.ciRunsAnalyzed);

  const allPredictions: Array<{ repository: string; planMode: "FULL" | "SELECTIVE"; testsSelectedDiffci: number; testsTotalFull: number; createdAt: string }> = [];
  for (const repo of repositories) {
    const preds = await deps.shadowBoundary.listPredictions(repo.ownerName, startOfUtcMonth(now).toISOString(), endOfUtcMonth(now).toISOString());
    allPredictions.push(...preds);
  }
  const selectiveCount = allPredictions.filter((p) => p.planMode === "SELECTIVE").length;
  const fullCount = allPredictions.filter((p) => p.planMode === "FULL").length;
  const perPredictionSavings = allPredictions.map((p) => computeSavingsForPrediction({ logicalDeltaKey: "", repository: p.repository, planMode: p.planMode, opportunityCategory: "DISCRIMINATIVE_OPPORTUNITY", testsSelectedDiffci: p.testsSelectedDiffci, testsTotalFull: p.testsTotalFull, createdAt: p.createdAt }, deps.savingsOptions));
  const savings = aggregateSavings(perPredictionSavings);

  const safetySnapshot = await deps.shadowBoundary.getSafetySnapshot(repositories[0]?.ownerName);
  const recentRunners = await deps.runnerStore.listRunnersForOrganization(organizationId, 10);

  const overview = buildDashboardOverview(org, repositories.length, usageSummary, { selective: selectiveCount, full: fullCount }, savings);
  const safety = buildDashboardSafety(safetySnapshot);
  const usage = buildDashboardUsage(entitlements, allowance);
  const recentActivity = buildDashboardRecentActivity(allPredictions.slice(0, 10), recentRunners);

  return { ok: true, data: buildDashboardContract(overview, safety, usage, recentActivity) };
}
