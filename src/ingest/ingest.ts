/**
 * Accepting an observation report (Phase 03, 2026-08-26).
 *
 * This is the only write path in DiffCI that an unauthenticated stranger can reach, and the only one
 * whose caller is a machine in somebody else's infrastructure. Four things therefore have to be true of
 * every accepted report, and each is a step below:
 *
 *   1. IT CAME WITH A CREDENTIAL WE ISSUED. No token, no ingest - there is no anonymous mode and no
 *      "trust the payload's repository field" mode.
 *   2. IT IS ABOUT THE REPOSITORY THAT CREDENTIAL IS FOR. The token names a repository; the report also
 *      claims one. When both are stated and they disagree, the report is rejected, not reconciled. That
 *      disagreement is what a token copied into a different repository's CI looks like, and it is the
 *      one signal that separates "org A wrote into org B" from ordinary use.
 *   3. IT IS A DOCUMENT WE UNDERSTAND. Schema checked before any field is read
 *      (src/client/report.ts's validateObservationReport), size capped before it is parsed at all.
 *   4. IT IS COUNTED EXACTLY ONCE. A workflow re-run, a client retry and a redelivery all produce the
 *      same report; the database's UNIQUE constraint decides, not this code.
 *
 * Rejections carry a machine-readable reason AND a message written for the person reading a failed step
 * in their own CI log. They are the only support channel a self-serve product has.
 */
import { validateObservationReport, type ObservationReport } from "../client/report.js";
import type { ProductStore } from "../product/store.js";
import type { UsageStore } from "../usage/store.js";
import type { IngestTokenStore } from "./token.js";
import type { NewObservation, ObservationStore } from "./store.js";
import type { IngestResult } from "./types.js";

/**
 * 1 MiB. A report of a large monorepo commit carrying several thousand paths is tens of kilobytes; a
 * megabyte is room for an order of magnitude more than anything measured, and small enough that the cap
 * is a real bound rather than a formality.
 */
export const MAX_REPORT_BYTES = 1024 * 1024;

export interface IngestDeps {
  tokenStore: IngestTokenStore;
  observationStore: ObservationStore;
  productStore: Pick<ProductStore, "getRepository" | "recordAuditEvent">;
  /** Optional: metering. Absent in tests that are not about usage. */
  usageStore?: Pick<UsageStore, "recordUsageEventIfNew">;
  maxReportBytes?: number;
}

export interface IngestRequest {
  /** The raw Authorization header, as received. Parsed here so no caller has to get it right twice. */
  authorization?: string | null;
  /** The request body, unparsed. */
  body: string;
}

function bearerToken(authorization: string | null | undefined): string | undefined {
  if (!authorization) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match ? match[1]!.trim() : undefined;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * What makes two reports "the same report".
 *
 * A GitHub run id plus attempt plus head SHA identifies one observation of one commit by one job
 * attempt: a re-run of the same attempt (a network retry from the action) collides, while a genuine
 * re-run of the workflow gets a new attempt number and is stored separately - which is correct, because
 * the second attempt really is a second observation.
 *
 * Outside CI there is no run id, so the report's own content is the identity. That makes a locally
 * produced report idempotent on its bytes, which is the most that can honestly be said about it.
 */
async function deriveIdempotencyKey(repositoryId: string, report: ObservationReport, body: string): Promise<string> {
  const runId = report.ci?.runId;
  if (runId) {
    const attempt = report.ci?.runAttempt ?? "1";
    const head = report.commitRange?.headSha ?? "no-range";
    return `${repositoryId}:run:${runId}:${attempt}:${head}`;
  }
  return `${repositoryId}:content:${await sha256Hex(body)}`;
}

function toNewObservation(input: {
  organizationId: string;
  repositoryId: string;
  idempotencyKey: string;
  report: ObservationReport;
  reportBytes: number;
  identityVerified: boolean;
}): NewObservation {
  const { report } = input;
  const result = report.result;
  return {
    organizationId: input.organizationId,
    repositoryId: input.repositoryId,
    idempotencyKey: input.idempotencyKey,
    schemaVersion: report.schema,
    status: report.status,
    stage: report.stage,
    refusalReason: report.reason,
    mode: result?.mode,
    baseSha: report.commitRange?.baseSha,
    headSha: report.commitRange?.headSha,
    rangeSource: report.commitRange?.source,
    ciRunId: report.ci?.runId,
    ciRunAttempt: report.ci?.runAttempt,
    ciEvent: report.ci?.event,
    ciWorkflow: report.ci?.workflow,
    ciJob: report.ci?.job,
    changedFileCount: result?.changedFileCount,
    selectedTestCount: result?.selectedTests.length,
    totalTestCount: result?.totalTestCount,
    baselineMode: result?.pathBaseline.mode,
    baselineSelectedTestCount: result?.pathBaseline.selectedTestCount,
    blindSpot: result?.blindSpot === true,
    worktreeUnchanged: report.nonInterference?.worktreeUnchanged === true,
    blockingWorkflowFindings: (report.nonInterference?.workflowFindings ?? []).filter((f) => f.severity === "BLOCKING").length,
    pathsRedacted: report.payload?.includesFilePaths === false,
    identityVerified: input.identityVerified,
    observerVersion: report.observer?.version,
    engineSha: report.observer?.engineSha,
    producedAt: report.producedAt,
    reportBytes: input.reportBytes,
    report,
  };
}

export async function ingestObservation(request: IngestRequest, deps: IngestDeps): Promise<IngestResult> {
  const raw = bearerToken(request.authorization);
  if (!raw) {
    return {
      ok: false,
      rejection: "missing_token",
      message: "No credential. Send the ingest token as `Authorization: Bearer dci_...` - the action reads it from the api-token input.",
    };
  }

  // Size is checked before parsing: a body too large to accept should not first be turned into objects.
  const reportBytes = byteLength(request.body);
  const maxBytes = deps.maxReportBytes ?? MAX_REPORT_BYTES;
  if (reportBytes > maxBytes) {
    return {
      ok: false,
      rejection: "payload_too_large",
      message: `Report is ${reportBytes} bytes; the limit is ${maxBytes}. Run the observer with --redact-paths, which replaces every path with a 12-character digest.`,
    };
  }

  const verification = await deps.tokenStore.verify(raw);
  if (!verification.ok) {
    const rejection = verification.reason === "revoked" ? "revoked_token" : verification.reason === "expired" ? "expired_token" : "invalid_token";
    const message =
      verification.reason === "revoked"
        ? "This ingest token was revoked. Issue a new one from the repository's settings and update the workflow secret."
        : verification.reason === "expired"
          ? "This ingest token has expired. Issue a new one and update the workflow secret."
          : "This ingest token is not recognised. Check that the workflow secret holds the whole value, including the dci_ prefix.";
    return { ok: false, rejection, message };
  }
  const token = verification.record;

  let parsed: unknown;
  try {
    parsed = JSON.parse(request.body);
  } catch {
    return { ok: false, rejection: "malformed_payload", message: "Body is not valid JSON." };
  }

  const validation = validateObservationReport(parsed);
  if (!validation.ok) {
    // A schema this server does not know is the expected consequence of a pinned action outliving a
    // server change - so it says which version it got, rather than "bad request".
    return {
      ok: false,
      rejection: "unsupported_schema",
      message: `${validation.error}. Update the pinned DiffCI action to a version this server supports.`,
    };
  }
  const report = validation.report;

  const repository = await deps.productStore.getRepository(token.repositoryId);
  if (!repository || repository.organizationId !== token.organizationId) {
    // The token outlived the repository record, or the repository moved organizations. Either way the
    // credential no longer names a place this report can go.
    return {
      ok: false,
      rejection: "repository_inactive",
      message: "The repository this token was issued for no longer exists in DiffCI. Re-connect the repository and issue a new token.",
    };
  }
  if (repository.status === "removed" || repository.status === "paused") {
    return {
      ok: false,
      rejection: "repository_inactive",
      message: `This repository is ${repository.status} in DiffCI, so observations are not being accepted for it.`,
    };
  }

  // The identity check. GitHub's numeric repository id is the only stable claim - it survives renames,
  // which "owner/name" does not - so it decides. A contradiction is rejected outright: it is what a
  // token pasted into a different repository's CI looks like, and accepting it would file one
  // repository's observations under another's, across organizations.
  const claimedId = report.repository?.providerRepositoryId;
  let identityVerified = false;
  if (claimedId !== undefined && claimedId !== "") {
    if (claimedId !== repository.providerRepositoryId) {
      return {
        ok: false,
        rejection: "repository_mismatch",
        message: `This token belongs to ${repository.ownerName}, but the report came from a different repository (id ${claimedId}). A token is valid for exactly one repository - issue a separate one there.`,
      };
    }
    identityVerified = true;
  }

  const idempotencyKey = await deriveIdempotencyKey(repository.id, report, request.body);
  const { record, duplicate } = await deps.observationStore.recordIfNew(
    toNewObservation({
      organizationId: repository.organizationId,
      repositoryId: repository.id,
      idempotencyKey,
      report,
      reportBytes,
      identityVerified,
    }),
  );

  // A duplicate stops here: it must not re-meter, re-audit, or refresh last_used_at, or a workflow
  // retrying ten times would look like ten observations and a dead token would look alive.
  if (duplicate) return { ok: true, duplicate: true, record };

  await deps.tokenStore.markUsed(token.id);

  if (deps.usageStore) {
    const occurredAt = report.producedAt;
    const events: Array<{ eventType: "ci_run_analyzed" | "tests_considered" | "tests_selected"; quantity: number; unit: string }> = [
      { eventType: "ci_run_analyzed", quantity: 1, unit: "count" },
    ];
    if (report.result) {
      events.push({ eventType: "tests_considered", quantity: report.result.totalTestCount, unit: "count" });
      events.push({ eventType: "tests_selected", quantity: report.result.selectedTests.length, unit: "count" });
    }
    for (const event of events) {
      await deps.usageStore.recordUsageEventIfNew({
        organizationId: repository.organizationId,
        repositoryId: repository.id,
        eventType: event.eventType,
        quantity: event.quantity,
        unit: event.unit,
        sourceType: "client_observation",
        // The observation's own identity, so metering dedupes on exactly what storage dedupes on.
        sourceId: `${idempotencyKey}:${event.eventType}`,
        occurredAt,
      });
    }
  }

  await deps.productStore.recordAuditEvent({
    organizationId: repository.organizationId,
    action: "observation.ingested",
    targetType: "observation",
    targetId: record.id,
    // No paths, no token, no report body - the audit trail records that it happened and to what.
    metadata: { repositoryId: repository.id, status: report.status, mode: report.result?.mode, identityVerified },
  });

  return { ok: true, duplicate: false, record };
}
