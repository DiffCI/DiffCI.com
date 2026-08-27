/**
 * Organization-scoped ingest routes (Phase 03, 2026-08-26).
 *
 * Same shape and same discipline as src/product/routes.ts: every function takes the requesting user
 * first and establishes membership before touching anything, so authorization is unit-testable without
 * a fetch() harness. Deliberately a separate module rather than more functions in product/routes.ts -
 * these need the two ingest stores, and widening RouteDeps would hand every existing route a token
 * store it has no business holding.
 *
 * TWO CHECKS, NOT ONE. Membership says the caller belongs to the organization. It does not say the
 * repository they named belongs to it too. Both are checked on every repository-scoped call, and a
 * repository from another organization comes back `not_found` rather than `unauthorized` - the
 * difference between those two answers is itself an information leak, because only one of them
 * confirms the thing exists.
 */
import type { ProductStore } from "../product/store.js";
import type { RouteOutcome } from "../product/routes.js";
import type { Repository } from "../product/types.js";
import { buildInstallInstructions, type InstallInstructions } from "./install.js";
import type { ObservationStore, ObservationSummary } from "./store.js";
import type { IngestTokenRecord, IngestTokenStore } from "./token.js";
import type { ObservationRecord } from "./types.js";

export interface IngestRouteDeps {
  productStore: ProductStore;
  tokenStore: IngestTokenStore;
  observationStore: ObservationStore;
  /** `owner/repo@ref` of the published DiffCI action, for generated install instructions. */
  actionRef: string;
  /** Public origin of this API, e.g. "https://diffci-product.example.workers.dev". */
  apiOrigin: string;
}

async function requireMembership(deps: IngestRouteDeps, organizationId: string, userId: string): Promise<boolean> {
  return deps.productStore.isMember(organizationId, userId);
}

/** Membership plus "this repository is actually theirs". Returns null for either failure. */
async function requireRepository(
  deps: IngestRouteDeps,
  organizationId: string,
  userId: string,
  repositoryId: string,
): Promise<Repository | null> {
  if (!(await requireMembership(deps, organizationId, userId))) return null;
  const repository = await deps.productStore.getRepository(repositoryId);
  if (!repository || repository.organizationId !== organizationId) return null;
  return repository;
}

/**
 * Mints an ingest credential for one repository. The raw token is in the response exactly once; there
 * is no route that can read it back, because nothing stores it.
 */
export async function issueIngestTokenForRepository(
  deps: IngestRouteDeps,
  userId: string,
  organizationId: string,
  repositoryId: string,
  input: { name?: string; ttlMs?: number } = {},
): Promise<RouteOutcome<{ token: string; record: IngestTokenRecord; install: InstallInstructions }>> {
  if (!(await requireMembership(deps, organizationId, userId))) return { ok: false, error: "unauthorized" };
  const repository = await requireRepository(deps, organizationId, userId, repositoryId);
  if (!repository) return { ok: false, error: "not_found" };

  const { raw, record } = await deps.tokenStore.issue({
    organizationId,
    repositoryId,
    name: input.name,
    createdByUserId: userId,
    ttlMs: input.ttlMs,
  });

  await deps.productStore.recordAuditEvent({
    organizationId,
    actorUserId: userId,
    action: "ingest_token.issued",
    targetType: "ingest_token",
    targetId: record.id,
    // The prefix only. Recording the token would put a live credential in the audit trail.
    metadata: { repositoryId, tokenPrefix: record.tokenPrefix },
  });

  return {
    ok: true,
    data: {
      token: raw,
      record,
      install: buildInstallInstructions({ repository, actionRef: deps.actionRef, apiOrigin: deps.apiOrigin }),
    },
  };
}

export async function listIngestTokensForOrganization(
  deps: IngestRouteDeps,
  userId: string,
  organizationId: string,
): Promise<RouteOutcome<IngestTokenRecord[]>> {
  if (!(await requireMembership(deps, organizationId, userId))) return { ok: false, error: "unauthorized" };
  return { ok: true, data: await deps.tokenStore.listForOrganization(organizationId) };
}

export async function revokeIngestToken(
  deps: IngestRouteDeps,
  userId: string,
  organizationId: string,
  tokenId: string,
): Promise<RouteOutcome<{ revoked: boolean }>> {
  if (!(await requireMembership(deps, organizationId, userId))) return { ok: false, error: "unauthorized" };
  // Scoped revoke: a token id from another organization matches no row here, so it comes back
  // not_found instead of quietly revoking somebody else's credential.
  const revoked = await deps.tokenStore.revoke(organizationId, tokenId);
  if (!revoked) return { ok: false, error: "not_found" };
  await deps.productStore.recordAuditEvent({
    organizationId,
    actorUserId: userId,
    action: "ingest_token.revoked",
    targetType: "ingest_token",
    targetId: tokenId,
  });
  return { ok: true, data: { revoked } };
}

export async function getInstallInstructionsForRepository(
  deps: IngestRouteDeps,
  userId: string,
  organizationId: string,
  repositoryId: string,
): Promise<RouteOutcome<InstallInstructions>> {
  const repository = await requireRepository(deps, organizationId, userId, repositoryId);
  if (!repository) {
    return { ok: false, error: (await requireMembership(deps, organizationId, userId)) ? "not_found" : "unauthorized" };
  }
  return { ok: true, data: buildInstallInstructions({ repository, actionRef: deps.actionRef, apiOrigin: deps.apiOrigin }) };
}

export async function listObservationsForOrganization(
  deps: IngestRouteDeps,
  userId: string,
  organizationId: string,
  options: { limit?: number; since?: string; repositoryId?: string } = {},
): Promise<RouteOutcome<{ observations: ObservationRecord[]; summary: ObservationSummary }>> {
  if (!(await requireMembership(deps, organizationId, userId))) return { ok: false, error: "unauthorized" };

  if (options.repositoryId !== undefined) {
    const repository = await requireRepository(deps, organizationId, userId, options.repositoryId);
    if (!repository) return { ok: false, error: "not_found" };
  }

  const observations = options.repositoryId
    ? await deps.observationStore.listForRepository(organizationId, options.repositoryId, { limit: options.limit, since: options.since })
    : await deps.observationStore.listForOrganization(organizationId, { limit: options.limit, since: options.since });
  const summary = await deps.observationStore.summarise(organizationId, { since: options.since });
  return { ok: true, data: { observations, summary } };
}

export async function getObservationForOrganization(
  deps: IngestRouteDeps,
  userId: string,
  organizationId: string,
  observationId: string,
): Promise<RouteOutcome<ObservationRecord>> {
  if (!(await requireMembership(deps, organizationId, userId))) return { ok: false, error: "unauthorized" };
  const record = await deps.observationStore.getForOrganization(organizationId, observationId);
  return record ? { ok: true, data: record } : { ok: false, error: "not_found" };
}

/**
 * Erasure on request. site/data-handling.html promises "ask, and it goes sooner"; this is that, as a
 * route rather than as a person running SQL. Scoped to the caller's own organization by construction -
 * there is no variant of this that can reach another tenant's rows.
 */
export async function deleteObservationsForOrganization(
  deps: IngestRouteDeps,
  userId: string,
  organizationId: string,
  options: { repositoryId?: string } = {},
): Promise<RouteOutcome<{ deleted: number }>> {
  if (!(await requireMembership(deps, organizationId, userId))) return { ok: false, error: "unauthorized" };

  let deleted: number;
  if (options.repositoryId !== undefined) {
    const repository = await requireRepository(deps, organizationId, userId, options.repositoryId);
    if (!repository) return { ok: false, error: "not_found" };
    deleted = await deps.observationStore.deleteForRepository(organizationId, options.repositoryId);
  } else {
    deleted = await deps.observationStore.deleteForOrganization(organizationId);
  }

  await deps.productStore.recordAuditEvent({
    organizationId,
    actorUserId: userId,
    action: "observations.deleted",
    targetType: options.repositoryId ? "repository" : "organization",
    targetId: options.repositoryId ?? organizationId,
    metadata: { deleted },
  });
  return { ok: true, data: { deleted } };
}
