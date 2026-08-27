/**
 * Ingest domain types (Phase 03, 2026-08-26).
 *
 * `ObservationRecord` is the server's row, not the client's document: the wire format is
 * src/client/report.ts's `ObservationReport`, produced by a pinned action of any age running in someone
 * else's CI. Keeping the two types apart is what lets the stored shape change without breaking every
 * installed observer, and stops server-side fields (which organization, when we received it, whether the
 * sender's identity claim checked out) from ever being things the sender could set.
 */

/** A stored observation, as the product reads it back. `report` is the document exactly as received. */
export interface ObservationRecord {
  id: string;
  organizationId: string;
  repositoryId: string;
  idempotencyKey: string;
  schemaVersion: string;
  status: "OBSERVED" | "REFUSED" | "ERROR";
  stage: string;
  refusalReason?: string;

  mode?: "SELECTIVE" | "FULL";
  baseSha?: string;
  headSha?: string;
  rangeSource?: string;

  ciRunId?: string;
  ciRunAttempt?: string;
  ciEvent?: string;
  ciWorkflow?: string;
  ciJob?: string;

  changedFileCount?: number;
  selectedTestCount?: number;
  totalTestCount?: number;
  baselineMode?: "SELECTIVE" | "FULL";
  baselineSelectedTestCount?: number;

  blindSpot: boolean;
  worktreeUnchanged: boolean;
  blockingWorkflowFindings: number;
  pathsRedacted: boolean;
  /**
   * Whether the report's own repository claim was checked against the credential it arrived on. False
   * means the report made no verifiable claim (a local run with no CI environment) - never that a
   * contradiction was tolerated, which is rejected before storage.
   */
  identityVerified: boolean;

  observerVersion?: string;
  engineSha?: string;
  producedAt: string;
  receivedAt: string;
  reportBytes: number;
  /** The document as received, parsed. Authoritative if it ever disagrees with the columns above. */
  report: unknown;
}

/**
 * Why an ingest attempt was rejected. These are the strings the sender sees, so each one has to name
 * the thing to change - the reader is usually a developer looking at a failed step in their own CI.
 */
export type IngestRejection =
  | "missing_token"
  | "invalid_token"
  | "revoked_token"
  | "expired_token"
  | "payload_too_large"
  | "malformed_payload"
  | "unsupported_schema"
  | "repository_mismatch"
  | "repository_inactive";

export type IngestResult =
  | { ok: true; duplicate: false; record: ObservationRecord }
  /** The same report, again: a re-run, a retry, a redelivery. Success, and counted exactly once. */
  | { ok: true; duplicate: true; record: ObservationRecord }
  | { ok: false; rejection: IngestRejection; message: string };
