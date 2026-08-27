/**
 * Installation webhooks - and the erasure they trigger (Phase 03 follow-up, 2026-08-26).
 *
 * site/data-handling.html makes two deletion promises. The 90-day cap is a sweep
 * (src/ingest/retention.ts). This file is the other one: "Uninstalling deletes it. Removing the App from
 * a repository deletes that repository's analysis records and evidence archives."
 *
 * That promise cannot be kept by a cron, because elapsed time is not the trigger - the customer's own
 * action is, and the only place that action shows up is a webhook. So uninstalling, or dropping a single
 * repository from an installation, deletes that repository's observations here, immediately, and revokes
 * its ingest credentials so a workflow left in place cannot re-create them.
 *
 * EVERY DELIVERY IS VERIFIED FIRST. The signature check is the only thing separating a real GitHub
 * delivery from an attacker POSTing `{"action":"deleted"}` at a public endpoint - which, on this
 * particular handler, would be a request to erase someone's data.
 */
import { verifyWebhookSignature } from "../shadow/github-app.js";
import type { ProductStore } from "../product/store.js";
import type { ObservationStore } from "../ingest/store.js";
import type { IngestTokenStore } from "../ingest/token.js";
import { connectInstallation, type ConnectInstallationDeps, type InstallationRepository } from "./github-installation.js";
import type { PendingInstallationStore } from "./pending.js";
import type { WebhookDeliveryStore } from "./delivery-log.js";

export interface InstallationWebhookDeps {
  productStore: ProductStore;
  observationStore: ObservationStore;
  tokenStore: IngestTokenStore;
  webhookSecret: string;
  /** Only needed to handle repositories being ADDED to an existing installation. */
  connectDeps?: Omit<ConnectInstallationDeps, "productStore">;
  /**
   * Where `installation.created` is parked (B3). Optional so existing tests and any environment
   * without the table configured degrade to the previous behaviour - ignoring the event - rather than
   * throwing. An environment without it simply cannot onboard install-first users.
   */
  pendingStore?: PendingInstallationStore;
  /**
   * Replay/duplicate suppression. Optional for the same reason, but note what its absence means: a
   * redelivered `installation.deleted` WILL erase again. Production must configure it.
   */
  deliveryStore?: WebhookDeliveryStore;
}

export interface InstallationWebhookRequest {
  rawBody: string;
  signature: string | null;
  event: string | null;
  /** GitHub's X-GitHub-Delivery header. Required whenever `deliveryStore` is configured. */
  deliveryId?: string | null;
}

export type InstallationWebhookResult =
  | { ok: true; action: "ignored"; reason: string; duplicate?: boolean }
  | { ok: true; action: "disconnected"; repositories: number; observationsDeleted: number; tokensRevoked: number }
  | { ok: true; action: "connected"; repositories: number }
  /** Recorded, deliberately unattributed, awaiting an authorized claim. See ./pending.ts. */
  | { ok: true; action: "parked"; repositories: number }
  | { ok: false; error: "bad_signature" | "malformed" };

interface WebhookPayload {
  action?: string;
  installation?: { id?: number; account?: { login?: string } };
  /** Present on `installation.created`: who performed the install. The claim authorization anchor. */
  sender?: { id?: number; login?: string };
  /** Present on `installation.created`: what the installation covers at creation time. */
  repositories?: Array<{ id?: number; full_name?: string }>;
  repositories_removed?: Array<{ id?: number; full_name?: string }>;
  repositories_added?: Array<{ id?: number; full_name?: string; default_branch?: string; private?: boolean }>;
}

/**
 * Erases everything DiffCI holds for one repository and stops it being able to send more. Ordered so a
 * failure part-way leaves the safe state: credentials die first, so nothing can arrive after the
 * observations are gone.
 */
async function disconnectRepository(
  deps: InstallationWebhookDeps,
  repository: { id: string; organizationId: string; ownerName: string },
): Promise<{ observationsDeleted: number; tokensRevoked: number }> {
  const tokens = await deps.tokenStore.listForRepository(repository.organizationId, repository.id);
  let tokensRevoked = 0;
  for (const token of tokens) {
    if (token.revokedAt) continue;
    if (await deps.tokenStore.revoke(repository.organizationId, token.id)) tokensRevoked++;
  }

  const observationsDeleted = await deps.observationStore.deleteForRepository(repository.organizationId, repository.id);
  await deps.productStore.setRepositoryStatus(repository.id, "removed");

  await deps.productStore.recordAuditEvent({
    organizationId: repository.organizationId,
    action: "repository.disconnected",
    targetType: "repository",
    targetId: repository.id,
    metadata: { ownerName: repository.ownerName, observationsDeleted, tokensRevoked },
  });
  return { observationsDeleted, tokensRevoked };
}

export async function handleInstallationWebhook(
  request: InstallationWebhookRequest,
  deps: InstallationWebhookDeps,
): Promise<InstallationWebhookResult> {
  if (!(await verifyWebhookSignature(request.rawBody, request.signature, deps.webhookSecret))) {
    return { ok: false, error: "bad_signature" };
  }

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(request.rawBody) as WebhookPayload;
  } catch {
    return { ok: false, error: "malformed" };
  }

  const installationId = payload.installation?.id === undefined ? undefined : String(payload.installation.id);
  if (!installationId) return { ok: true, action: "ignored", reason: "delivery carried no installation id" };

  const event = request.event ?? "";

  // Duplicate/replay suppression, AFTER signature verification (an unsigned request must never get to
  // write a row and thereby suppress the real delivery that shares its id) and BEFORE any handler runs.
  // See ./delivery-log.ts for why the claim precedes the work rather than following it.
  if (deps.deliveryStore) {
    if (!request.deliveryId) {
      // A signed delivery with no X-GitHub-Delivery header is not something GitHub sends. Refusing is
      // safer than processing an un-deduplicatable destructive event.
      return { ok: true, action: "ignored", reason: "delivery carried no delivery id" };
    }
    const claim = await deps.deliveryStore.claim({ deliveryId: request.deliveryId, event, action: payload.action });
    if (!claim.claimed) {
      return { ok: true, action: "ignored", reason: `duplicate delivery (previous attempt: ${claim.previousStatus})`, duplicate: true };
    }
    try {
      const result = await dispatch(request, deps, payload, installationId, event);
      await deps.deliveryStore.complete(request.deliveryId, summarizeForLog(result));
      return result;
    } catch (error) {
      // Marked `failed`, not left `processing`: a handler that threw cleanly did not complete, so
      // GitHub's redelivery should be allowed to try again.
      await deps.deliveryStore.fail(request.deliveryId, error instanceof Error ? error.name : "unknown_error");
      throw error;
    }
  }

  return dispatch(request, deps, payload, installationId, event);
}

/** Short, non-sensitive outcome line for the delivery log. Never includes payload content. */
function summarizeForLog(result: InstallationWebhookResult): string {
  if (!result.ok) return `error:${result.error}`;
  if (result.action === "ignored") return `ignored:${result.reason}`;
  if (result.action === "disconnected") return `disconnected:${result.repositories}r/${result.observationsDeleted}o/${result.tokensRevoked}t`;
  if (result.action === "parked") return `parked:${result.repositories}r`;
  return `connected:${result.repositories}r`;
}

async function dispatch(
  request: InstallationWebhookRequest,
  deps: InstallationWebhookDeps,
  payload: WebhookPayload,
  installationId: string,
  event: string,
): Promise<InstallationWebhookResult> {
  // A brand-new installation, which is what someone who installs from the App's own GitHub page
  // produces (B3). It is PARKED, never attributed: this delivery names a GitHub account and a sender,
  // not a DiffCI organization, and guessing which tenant it belongs to is precisely the cross-tenant
  // mistake the rest of this file exists to prevent. See ./pending.ts.
  if (event === "installation" && payload.action === "created") {
    if (!deps.pendingStore) return { ok: true, action: "ignored", reason: "installation parking is not configured in this environment" };
    const senderProviderUserId = payload.sender?.id === undefined ? undefined : String(payload.sender.id);
    await deps.pendingStore.record({
      installationId,
      accountLogin: payload.installation?.account?.login,
      senderProviderUserId,
      repositoryCount: payload.repositories?.length ?? 0,
    });
    return { ok: true, action: "parked", repositories: payload.repositories?.length ?? 0 };
  }

  // The App was removed from the account entirely, or suspended. Everything it covered goes.
  if (event === "installation" && (payload.action === "deleted" || payload.action === "suspend")) {
    const repositories = await deps.productStore.listRepositoriesByInstallation(installationId);
    let observationsDeleted = 0;
    let tokensRevoked = 0;
    for (const repository of repositories) {
      const result = await disconnectRepository(deps, repository);
      observationsDeleted += result.observationsDeleted;
      tokensRevoked += result.tokensRevoked;
    }
    return { ok: true, action: "disconnected", repositories: repositories.length, observationsDeleted, tokensRevoked };
  }

  // Individual repositories dropped from an installation that otherwise stays.
  if (event === "installation_repositories" && (payload.repositories_removed?.length ?? 0) > 0) {
    const removedIds = new Set((payload.repositories_removed ?? []).map((r) => String(r.id)));
    const attached = await deps.productStore.listRepositoriesByInstallation(installationId);
    const affected = attached.filter((repository) => removedIds.has(repository.providerRepositoryId));
    let observationsDeleted = 0;
    let tokensRevoked = 0;
    for (const repository of affected) {
      const result = await disconnectRepository(deps, repository);
      observationsDeleted += result.observationsDeleted;
      tokensRevoked += result.tokensRevoked;
    }
    return { ok: true, action: "disconnected", repositories: affected.length, observationsDeleted, tokensRevoked };
  }

  if (event === "installation_repositories" && (payload.repositories_added?.length ?? 0) > 0) {
    // Which organization is this? The webhook does not say, and must not be trusted to: the only
    // trustworthy answer is a repository already attached to this installation by an authenticated
    // member. Without one, the delivery is ignored rather than attributed by guesswork.
    const attached = await deps.productStore.listRepositoriesByInstallation(installationId);
    const organizationId = attached[0]?.organizationId;
    if (!organizationId || !deps.connectDeps) {
      return { ok: true, action: "ignored", reason: "no organization is known for this installation yet" };
    }
    const added: InstallationRepository[] = (payload.repositories_added ?? []).map((r) => ({
      providerRepositoryId: String(r.id),
      ownerName: r.full_name ?? "",
      defaultBranch: r.default_branch ?? "main",
      private: r.private === true,
    }));
    const result = await connectInstallation(
      { ...deps.connectDeps, productStore: deps.productStore, listRepositories: async () => added },
      { organizationId, installationId },
    );
    return { ok: true, action: "connected", repositories: result.connected + result.updated };
  }

  return { ok: true, action: "ignored", reason: `nothing to do for ${event}/${payload.action ?? "unknown"}` };
}
