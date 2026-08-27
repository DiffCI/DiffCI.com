/**
 * Ledger routes (Phase 04, 2026-08-26).
 *
 * Same discipline as src/ingest/routes.ts: the requesting user first, membership before anything, and
 * the observations the ledger is built from come out of the organization-scoped store method - so a
 * month can only ever be built from rows that organization owns.
 */
import type { ProductStore } from "../product/store.js";
import type { RouteOutcome } from "../product/routes.js";
import type { ObservationStore } from "../ingest/store.js";
import { buildMonthlyLedger, monthBounds, type MonthlyLedger } from "./ledger.js";
import type { NetSavingsInput } from "./net-savings.js";

export interface LedgerRouteDeps {
  productStore: ProductStore;
  observationStore: ObservationStore;
  /** Per-repository duration assumptions, when any exist. Absent keeps time and cost UNKNOWN. */
  savingsInput?: (repositoryId: string) => NetSavingsInput;
}

/** The most observations a single month's ledger will read. A bound, not a belief about volume. */
const MAX_OBSERVATIONS_PER_MONTH = 1000;

export async function getMonthlyLedgerForOrganization(
  deps: LedgerRouteDeps,
  userId: string,
  organizationId: string,
  month: string,
): Promise<RouteOutcome<MonthlyLedger>> {
  if (!(await deps.productStore.isMember(organizationId, userId))) return { ok: false, error: "unauthorized" };

  let bounds: { from: string; to: string };
  try {
    bounds = monthBounds(month);
  } catch {
    return { ok: false, error: "not_found" };
  }

  const [observations, repositories] = await Promise.all([
    deps.observationStore.listForOrganization(organizationId, { since: bounds.from, limit: MAX_OBSERVATIONS_PER_MONTH }),
    deps.productStore.listRepositories(organizationId),
  ]);

  return {
    ok: true,
    data: buildMonthlyLedger({
      organizationId,
      month,
      observations,
      repositoryNames: new Map(repositories.map((repository) => [repository.id, repository.ownerName])),
      savingsInput: deps.savingsInput,
    }),
  };
}

/** "YYYY-MM" for a date, UTC - the month a caller means when they say "this month". */
export function currentMonth(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}
