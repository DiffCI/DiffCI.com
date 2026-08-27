/**
 * Retention (Phase 03, 2026-08-26).
 *
 * site/data-handling.html says "90 days maximum, regardless. Nothing is kept beyond 90 days from the
 * analysis that produced it, whether or not the App is still installed." That page carries a banner
 * saying it must not be published because the automated deletion path does not exist. This is that
 * path, for the data Phase 03 introduces.
 *
 * It is a sweep, not a trigger: rows are removed by elapsed time on a schedule, so nothing depends on a
 * webhook arriving, a session being live, or a person remembering. It crosses tenants by definition -
 * the promise is about every row, not about one organization's - which is why it uses the store's
 * explicitly `unscoped` methods and why those methods are named that way.
 */
import type { ObservationStore } from "./store.js";

/** The published cap. Changing this number changes a public commitment, not a configuration value. */
export const RETENTION_DAYS = 90;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface RetentionSweepResult {
  cutoff: string;
  deleted: number;
  retentionDays: number;
}

export function retentionCutoffIso(now: Date = new Date(), retentionDays: number = RETENTION_DAYS): string {
  return new Date(now.getTime() - retentionDays * MS_PER_DAY).toISOString();
}

export async function runRetentionSweep(
  store: ObservationStore,
  options: { now?: Date; retentionDays?: number } = {},
): Promise<RetentionSweepResult> {
  const retentionDays = options.retentionDays ?? RETENTION_DAYS;
  const cutoff = retentionCutoffIso(options.now ?? new Date(), retentionDays);
  const deleted = await store.unscopedPurgeReceivedBefore(cutoff);
  return { cutoff, deleted, retentionDays };
}

/**
 * How many rows are currently past the cap. Zero is the only healthy answer, and it is worth being able
 * to state that without deleting anything first - a sweep that has silently stopped running looks
 * identical to one with nothing to do, unless something counts.
 */
export async function countOverdueObservations(
  store: ObservationStore,
  options: { now?: Date; retentionDays?: number } = {},
): Promise<{ cutoff: string; overdue: number }> {
  const cutoff = retentionCutoffIso(options.now ?? new Date(), options.retentionDays ?? RETENTION_DAYS);
  return { cutoff, overdue: await store.unscopedCountReceivedBefore(cutoff) };
}
