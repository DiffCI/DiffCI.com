/**
 * Bounded, idempotent recompute of the DERIVED estimate fields on shadow_economics_observations
 * (External Shadow Pilot M2, 2026-08-26).
 *
 * Exists because captured rows would otherwise be frozen at whatever the estimator said on the day they
 * were written, and two real situations make that unacceptable:
 *
 *   1. A row captured before its inputs were usable sits at UNKNOWN forever. Every repository's FIRST
 *      observation hit this, including the only SELECTIVE unjs/h3 commit - precisely the most valuable
 *      row in the table - so a 7-day report would have silently omitted the best evidence it had.
 *   2. A row estimated by a WITHDRAWN estimator keeps its wrong number. v1 reported 28s avoidable for a
 *      commit that executed all 70 of its tests. Backfilling only UNKNOWN rows would have left that
 *      known-bad value sitting in the database, still eligible to appear in a report.
 *
 * Raw telemetry is never touched: measured workload, test counts, commit identity and plan mode are
 * inputs, not outputs, and store.applyRecompute's UPDATE lists only derived columns. Every change writes
 * a before/after audit row first, so any number that ever reached a research or customer-facing report
 * can be reconstructed and explained.
 *
 * Idempotent and self-terminating by construction: candidates are selected ONLY by
 * `estimator_version IS NULL OR estimator_version < ESTIMATOR_VERSION`, and every applied recompute
 * stamps the current version - so a second run over settled data selects nothing and mutates nothing.
 */
import { ESTIMATOR_VERSION, estimateStageEconomics } from "./economics-estimator.js";
import type { ShadowEconomicsStore } from "./shadow-economics-store.js";

export interface ShadowEconomicsRecomputeDeps {
  store: ShadowEconomicsStore;
  nowIso?: () => string;
}

export interface ShadowEconomicsRecomputeResult {
  examined: number;
  recomputed: number;
  /** Tier transitions, e.g. {"UNKNOWN->ESTIMATED": 3, "ESTIMATED->ESTIMATED": 1} - makes a backfill's
   * real effect legible in one log line instead of requiring a follow-up query. */
  tierTransitions: Record<string, number>;
  /** Rows whose avoidable figure actually moved, and by how much in total - the number to look at when
   * asking "did withdrawing v1 change what we would have reported?" */
  avoidableMsDelta: number;
  errors: number;
}

export async function runShadowEconomicsRecompute(deps: ShadowEconomicsRecomputeDeps, maxRows: number): Promise<ShadowEconomicsRecomputeResult> {
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const result: ShadowEconomicsRecomputeResult = { examined: 0, recomputed: 0, tierTransitions: {}, avoidableMsDelta: 0, errors: 0 };

  const rows = await deps.store.listRowsNeedingRecompute(ESTIMATOR_VERSION, maxRows);
  result.examined = rows.length;

  for (const row of rows) {
    try {
      const after = estimateStageEconomics({
        stage: row.stage,
        fullWorkloadMs: row.fullWorkloadMs,
        testsSelectedDiffci: row.testsSelectedDiffci,
        testsTotalFull: row.testsTotalFull,
        planMode: row.planMode,
      });

      // Snapshot the previous values BEFORE applying. A store implementation is entitled to mutate the
      // row object it handed us (the in-memory one does), so reading row.* afterwards would report the
      // NEW value as the old one and silently flatten every transition to X->X.
      const beforeTier = row.avoidableTier;
      const beforeAvoidableMs = row.avoidableMs;
      const beforeSelectedMs = row.selectedWorkloadMs;

      await deps.store.applyRecompute({
        logicalDeltaKey: row.logicalDeltaKey,
        stage: row.stage,
        repository: row.repository,
        // "this row could not be estimated before and now can" vs "this row was estimated by an estimator
        // we no longer trust" are different events and are worth telling apart in the audit trail.
        reason: beforeTier === "UNKNOWN" && after.avoidableTier !== "UNKNOWN" ? "unknown_now_estimable" : "estimator_version_upgrade",
        fromEstimatorVersion: row.estimatorVersion,
        toEstimatorVersion: ESTIMATOR_VERSION,
        before: { selectedWorkloadMs: beforeSelectedMs, avoidableMs: beforeAvoidableMs, avoidableTier: beforeTier },
        after,
        recomputedAt: nowIso(),
      });

      const transition = `${beforeTier}->${after.avoidableTier}`;
      result.tierTransitions[transition] = (result.tierTransitions[transition] ?? 0) + 1;
      result.avoidableMsDelta += (after.avoidableMs ?? 0) - (beforeAvoidableMs ?? 0);
      result.recomputed++;
    } catch {
      // One bad row must never stall the backfill - the rest of the batch still gets corrected, and this
      // row is naturally retried next sweep because its estimator_version was never stamped.
      result.errors++;
    }
  }

  return result;
}
