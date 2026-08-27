/**
 * Parked, unattributed App installations - and the authorized claim that attaches one (B3, 2026-08-27).
 *
 * THE PROBLEM. Phase 03 shipped exactly one working path into DiffCI: sign in, click Install in the
 * console, get redirected to GitHub, come back to /app/install/callback carrying a server-generated
 * single-use state. That path is sound. It is also not the path most people take, because GitHub's own
 * App page - the URL you hand anyone, and the one the marketing site links - installs first and asks
 * questions later. Those installations produced an `installation.created` delivery that the webhook
 * handler ignored outright, and then dropped the person on a setup URL with no state to consume. No
 * error, no route forward, no trace. That is the single most likely first experience of DiffCI, and it
 * was a dead end.
 *
 * WHY NOT JUST ATTRIBUTE IT FROM THE WEBHOOK. Because the webhook cannot answer the only question that
 * matters. It carries a GitHub account and a sender, not a DiffCI organization; a sender may belong to
 * several organizations, or to none yet. Picking one would be the same class of mistake Phase 03 is
 * built to prevent - the difference between "GitHub says this person installed something" and "this
 * authenticated session is entitled to act for that tenant" is the whole of multi-tenant safety.
 *
 * SO THE DELIVERY IS PARKED, NOT APPLIED. `installation.created` records a row here and does nothing
 * else. Attachment happens later, in a request that carries a real session, and only when BOTH hold:
 *
 *   1. the signed-in user's linked GitHub identity equals the sender who performed the install, and
 *   2. that user is a member of the organization they are attaching it to.
 *
 * Neither check is inferable from the webhook, which is exactly why the claim is a separate step
 * rather than a smarter handler.
 */
import type { D1Binding } from "../ingest/token.js";
import type { ProductStore } from "../product/store.js";
import type { OAuthStore } from "../auth/oauth-store.js";
import { connectInstallation, type ConnectInstallationDeps, type ConnectInstallationResult } from "./github-installation.js";

export interface PendingInstallation {
  installationId: string;
  accountLogin?: string;
  /** GitHub's numeric user id of the installer. Absent means this row can never be claimed. */
  senderProviderUserId?: string;
  repositoryCount: number;
  createdAt: string;
  claimedAt?: string;
  claimedByUserId?: string;
  claimedOrganizationId?: string;
}

export interface PendingInstallationStore {
  /** Idempotent: a redelivered `installation.created` updates the row rather than duplicating it, and
   * never resurrects one that has already been claimed. */
  record(input: { installationId: string; accountLogin?: string; senderProviderUserId?: string; repositoryCount: number }): Promise<void>;
  get(installationId: string): Promise<PendingInstallation | null>;
  /** Unclaimed installations performed by this GitHub identity - what the console offers to attach. */
  listUnclaimedForSender(senderProviderUserId: string): Promise<PendingInstallation[]>;
  markClaimed(input: { installationId: string; userId: string; organizationId: string }): Promise<void>;
  remove(installationId: string): Promise<void>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function optional(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function toPending(row: Record<string, unknown>): PendingInstallation {
  return {
    installationId: String(row.installation_id),
    accountLogin: optional(row.account_login),
    senderProviderUserId: optional(row.sender_provider_user_id),
    repositoryCount: Number(row.repository_count ?? 0),
    createdAt: String(row.created_at),
    claimedAt: optional(row.claimed_at),
    claimedByUserId: optional(row.claimed_by_user_id),
    claimedOrganizationId: optional(row.claimed_organization_id),
  };
}

export function makeD1PendingInstallationStore(db: D1Binding): PendingInstallationStore {
  return {
    async record({ installationId, accountLogin, senderProviderUserId, repositoryCount }) {
      // The WHERE clause on the conflict branch is the idempotency guarantee that matters: a
      // redelivered `installation.created` for an ALREADY-CLAIMED installation must not blank out the
      // claim and re-open it for someone else to take.
      await db
        .prepare(
          `INSERT INTO pending_installations (installation_id, account_login, sender_provider_user_id, repository_count, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (installation_id) DO UPDATE SET
             account_login = excluded.account_login,
             sender_provider_user_id = excluded.sender_provider_user_id,
             repository_count = excluded.repository_count
           WHERE pending_installations.claimed_at IS NULL`,
        )
        .bind(installationId, accountLogin ?? null, senderProviderUserId ?? null, repositoryCount, nowIso())
        .run();
    },

    async get(installationId) {
      const row = await db.prepare(`SELECT * FROM pending_installations WHERE installation_id = ?`).bind(installationId).first<Record<string, unknown>>();
      return row ? toPending(row) : null;
    },

    async listUnclaimedForSender(senderProviderUserId) {
      const rows = await db
        .prepare(`SELECT * FROM pending_installations WHERE sender_provider_user_id = ? AND claimed_at IS NULL ORDER BY created_at DESC LIMIT 50`)
        .bind(senderProviderUserId)
        .all<Record<string, unknown>>();
      return (rows.results ?? []).map(toPending);
    },

    async markClaimed({ installationId, userId, organizationId }) {
      await db
        .prepare(`UPDATE pending_installations SET claimed_at = ?, claimed_by_user_id = ?, claimed_organization_id = ? WHERE installation_id = ? AND claimed_at IS NULL`)
        .bind(nowIso(), userId, organizationId, installationId)
        .run();
    },

    async remove(installationId) {
      await db.prepare(`DELETE FROM pending_installations WHERE installation_id = ?`).bind(installationId).run();
    },
  };
}

export type ClaimRefusal =
  /** No parked installation with that id. */
  | "unknown_installation"
  /** Someone already attached it - possibly this same user, possibly not. Never re-attributed. */
  | "already_claimed"
  /** The signed-in user is not the GitHub account that performed the installation. */
  | "not_installer"
  /** The signed-in user is not a member of the organization they named. */
  | "unauthorized";

export type ClaimResult = { ok: true; result: ConnectInstallationResult } | { ok: false; refusal: ClaimRefusal };

export interface ClaimInstallationDeps {
  pendingStore: PendingInstallationStore;
  productStore: ProductStore;
  oauthStore: OAuthStore;
  connectDeps: Omit<ConnectInstallationDeps, "productStore">;
}

/**
 * Attach a parked installation to an organization, on behalf of an authenticated user.
 *
 * The order of the checks is deliberate and is the security argument:
 *
 *   1. the installation exists and is unclaimed  - cheapest, and leaks nothing
 *   2. the caller IS the installer               - proves control of the GitHub account that installed
 *   3. the caller may act for the organization   - proves control of the DiffCI tenant
 *
 * Only then is GitHub asked what the installation covers, and `connectInstallation` applies its own
 * separate rule on top: a repository already claimed by a different organization is REFUSED, never
 * moved. So even a caller who passes all three checks cannot use this path to capture somebody else's
 * repository.
 *
 * The claim is marked BEFORE the repositories are connected. If connection then fails, the row stays
 * claimed by this user and this organization - the retry re-runs connection under the same
 * attribution, rather than re-opening the installation for a different tenant to grab in between.
 */
export async function claimInstallation(
  deps: ClaimInstallationDeps,
  input: { installationId: string; userId: string; organizationId: string },
): Promise<ClaimResult> {
  const pending = await deps.pendingStore.get(input.installationId);
  if (!pending) return { ok: false, refusal: "unknown_installation" };
  if (pending.claimedAt) return { ok: false, refusal: "already_claimed" };

  // A row whose sender is unknown is unclaimable by construction: there is no identity to match, so
  // there is no way to prove the caller performed the install. Fail closed rather than wave it through.
  if (!pending.senderProviderUserId) return { ok: false, refusal: "not_installer" };
  const installerUserId = await deps.oauthStore.getUserIdForProviderIdentity("github", pending.senderProviderUserId);
  if (!installerUserId || installerUserId !== input.userId) return { ok: false, refusal: "not_installer" };

  if (!(await deps.productStore.isMember(input.organizationId, input.userId))) return { ok: false, refusal: "unauthorized" };

  await deps.pendingStore.markClaimed({ installationId: input.installationId, userId: input.userId, organizationId: input.organizationId });

  const result = await connectInstallation(
    { ...deps.connectDeps, productStore: deps.productStore },
    { organizationId: input.organizationId, userId: input.userId, installationId: input.installationId },
  );
  return { ok: true, result };
}
