/**
 * The two deletion commitments site/data-handling.html makes about the Shadow pipeline:
 *
 *   "Uninstalling deletes it. Removing the App from a repository deletes that repository's
 *   analysis records and evidence archives."
 *   "90 days maximum, regardless. Nothing is kept beyond 90 days from the analysis that produced
 *   it, whether or not the App is still installed."
 *
 * Both are orchestrated the same shape: read the R2 evidence keys a set of D1 rows names, delete
 * those R2 objects, THEN delete the D1 rows. That order matters - the R2 key exists nowhere except
 * inside the D1 row that is about to be removed, so reading it after deletion is impossible, and
 * deleting R2 first means a crash between the two steps leaves an orphaned R2 object (wasted space,
 * silently cleaned up by a later sweep once nothing references it) rather than a D1 row that still
 * looks intact while its evidence archive is already gone.
 *
 * This module holds only the two orchestration functions - the D1 queries live on ShadowStore
 * (shadow-store.ts, kept next to every other shadow_* query for the same reason
 * getRepositorySummary lives there) and the R2 batch-delete lives on R2EvidenceStore (r2-store.ts).
 * Both dependencies are the exact interfaces already used everywhere else in this pipeline, so this
 * is unit-testable against the same hand-rolled D1Binding/R2Binding fakes as the rest of the test
 * suite - no live Cloudflare resources required.
 */

import type { ShadowStore } from "./shadow-store.js";

/** The subset of ShadowStore this module needs - named explicitly so a reader doesn't have to
 * cross-reference the full interface to see what erasure touches. */
export type ErasureStore = Pick<
  ShadowStore,
  | "listRepositoriesByInstallation"
  | "collectEvidenceKeys"
  | "eraseAnalysisRecordsForRepository"
  | "markRepositoryRemoved"
  | "listExpiredEvidenceKeys"
  | "eraseExpiredAnalysisRecords"
>;

export interface ErasureBucket {
  deleteMany(keys: string[]): Promise<number>;
}

export interface InstallationEraseResult {
  installationId: string;
  repositories: string[];
  predictionsDeleted: number;
  groundTruthDeleted: number;
  economicsDeleted: number;
  evidenceObjectsDeleted: number;
}

/**
 * `installation.deleted` handler. Every repository still attributed to this installation has its
 * analysis records and evidence archives erased, then is marked REMOVED with its installation id
 * cleared - a stale id left in place could otherwise be used to try to mint an installation token
 * that GitHub will (correctly) refuse, but the row would misleadingly still look "installed" until
 * that failure surfaced elsewhere.
 */
export async function eraseInstallation(store: ErasureStore, bucket: ErasureBucket, installationId: string, erasedAtIso: string): Promise<InstallationEraseResult> {
  const repositories = await store.listRepositoriesByInstallation(installationId);
  let predictionsDeleted = 0;
  let groundTruthDeleted = 0;
  let economicsDeleted = 0;
  let evidenceObjectsDeleted = 0;

  for (const repository of repositories) {
    const keys = await store.collectEvidenceKeys(repository);
    evidenceObjectsDeleted += await bucket.deleteMany(keys);
    const counts = await store.eraseAnalysisRecordsForRepository(repository);
    predictionsDeleted += counts.predictionsDeleted;
    groundTruthDeleted += counts.groundTruthDeleted;
    economicsDeleted += counts.economicsDeleted;
    await store.markRepositoryRemoved(repository, erasedAtIso);
  }

  return { installationId, repositories, predictionsDeleted, groundTruthDeleted, economicsDeleted, evidenceObjectsDeleted };
}

export interface RetentionSweepResult {
  cutoffIso: string;
  predictionsDeleted: number;
  groundTruthDeleted: number;
  economicsDeleted: number;
  evidenceObjectsDeleted: number;
}

/**
 * The 90-day cap, independent of install state - a repository that is still installed loses
 * evidence older than the cutoff exactly the same as one that was uninstalled long ago. Idempotent
 * and cheap to call repeatedly: a sweep that finds nothing expired does one read and zero deletes.
 * `nowIso` is caller-supplied (never `new Date()` internally) so this stays testable against a fixed
 * clock, the same discipline getReconcileDiagnostics already holds to.
 */
export async function sweepExpiredEvidence(store: ErasureStore, bucket: ErasureBucket, nowIso: string, maxAgeDays = 90): Promise<RetentionSweepResult> {
  const cutoffIso = new Date(Date.parse(nowIso) - maxAgeDays * 86_400_000).toISOString();
  const keys = await store.listExpiredEvidenceKeys(cutoffIso);
  const evidenceObjectsDeleted = await bucket.deleteMany(keys);
  const counts = await store.eraseExpiredAnalysisRecords(cutoffIso);
  return { cutoffIso, ...counts, evidenceObjectsDeleted };
}
