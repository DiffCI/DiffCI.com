import type { OrganizationRole, Repository } from "./types.js";
import type { D1Binding, ProductStore } from "./store.js";

export type ManagedExecutionMode = "observation_only" | "verification";

export interface ManagedExecutionConsent {
  organizationId: string;
  repositoryId: string;
  mode: ManagedExecutionMode;
  revision: number;
  consentedByUserId?: string;
  consentedAt?: string;
  maxDurationSeconds: number;
}

export interface ManagedExecutionAdmission {
  allowed: boolean;
  reason:
    | "authorized"
    | "repository_inactive"
    | "tenant_mismatch"
    | "consent_missing"
    | "observation_only"
    | "immutable_commit_required"
    | "provider_unavailable"
    | "artifact_unpinned";
}

export const DEFAULT_MANAGED_EXECUTION_CONSENT: ManagedExecutionConsent = {
  organizationId: "",
  repositoryId: "",
  mode: "observation_only",
  revision: 0,
  maxDurationSeconds: 900,
};

export function canChangeManagedExecution(role: OrganizationRole): boolean {
  return role === "owner" || role === "admin";
}

export function validateManagedExecutionConsent(input: ManagedExecutionConsent): string | undefined {
  if (!input.organizationId || !input.repositoryId) return "organizationId and repositoryId are required";
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) return "revision must be a non-negative integer";
  if (!Number.isSafeInteger(input.maxDurationSeconds) || input.maxDurationSeconds < 60 || input.maxDurationSeconds > 3600) {
    return "maxDurationSeconds must be an integer from 60 through 3600";
  }
  if (input.mode === "verification" && (!input.consentedByUserId || !input.consentedAt || !Number.isFinite(Date.parse(input.consentedAt)))) {
    return "verification mode requires an identified actor and valid consent timestamp";
  }
  return undefined;
}

export function decideManagedExecutionAdmission(input: {
  organizationId: string;
  repository: Repository;
  consent?: ManagedExecutionConsent;
  commitSha: string;
  providerAvailable: boolean;
  agentArtifactPinned: boolean;
}): ManagedExecutionAdmission {
  if (input.repository.organizationId !== input.organizationId) return { allowed: false, reason: "tenant_mismatch" };
  if (input.repository.status !== "active") return { allowed: false, reason: "repository_inactive" };
  if (!input.consent || validateManagedExecutionConsent(input.consent)) return { allowed: false, reason: "consent_missing" };
  if (input.consent.organizationId !== input.organizationId || input.consent.repositoryId !== input.repository.id) {
    return { allowed: false, reason: "tenant_mismatch" };
  }
  if (input.consent.mode !== "verification") return { allowed: false, reason: "observation_only" };
  if (!/^[0-9a-f]{40}$/.test(input.commitSha)) return { allowed: false, reason: "immutable_commit_required" };
  if (!input.providerAvailable) return { allowed: false, reason: "provider_unavailable" };
  if (!input.agentArtifactPinned) return { allowed: false, reason: "artifact_unpinned" };
  return { allowed: true, reason: "authorized" };
}

export interface ManagedExecutionConsentStore {
  current(organizationId: string, repositoryId: string): Promise<ManagedExecutionConsent>;
  history(organizationId: string, repositoryId: string): Promise<ManagedExecutionConsent[]>;
  append(input: { organizationId: string; repositoryId: string; actorUserId: string; expectedRevision: number; mode: ManagedExecutionMode; maxDurationSeconds: number }): Promise<ManagedExecutionConsent | null>;
}

function consentFromRow(row: Record<string, unknown>): ManagedExecutionConsent {
  return {
    organizationId: String(row.organization_id), repositoryId: String(row.repository_id),
    mode: row.mode as ManagedExecutionMode, revision: Number(row.revision),
    consentedByUserId: String(row.actor_user_id), consentedAt: String(row.created_at),
    maxDurationSeconds: Number(row.max_duration_seconds),
  };
}

export function makeD1ManagedExecutionConsentStore(db: D1Binding): ManagedExecutionConsentStore {
  return {
    async current(organizationId, repositoryId) {
      const row = await db.prepare(`SELECT * FROM repository_execution_consents
        WHERE organization_id = ? AND repository_id = ? ORDER BY revision DESC LIMIT 1`)
        .bind(organizationId, repositoryId).first<Record<string, unknown>>();
      return row ? consentFromRow(row) : { ...DEFAULT_MANAGED_EXECUTION_CONSENT, organizationId, repositoryId };
    },
    async history(organizationId, repositoryId) {
      const { results } = await db.prepare(`SELECT * FROM repository_execution_consents
        WHERE organization_id = ? AND repository_id = ? ORDER BY revision DESC LIMIT 100`)
        .bind(organizationId, repositoryId).all<Record<string, unknown>>();
      return results.map(consentFromRow);
    },
    async append(input) {
      const createdAt = new Date().toISOString();
      const row = await db.prepare(`INSERT INTO repository_execution_consents
        (repository_id, organization_id, revision, mode, max_duration_seconds, actor_user_id, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ? WHERE
          COALESCE((SELECT MAX(revision) FROM repository_execution_consents WHERE repository_id = ? AND organization_id = ?), 0) = ?
          AND EXISTS (SELECT 1 FROM repositories WHERE id = ? AND organization_id = ? AND status = 'active')
          AND EXISTS (SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ? AND role IN ('owner', 'admin'))
        ON CONFLICT(repository_id, revision) DO NOTHING RETURNING *`)
        .bind(input.repositoryId, input.organizationId, input.expectedRevision + 1, input.mode, input.maxDurationSeconds,
          input.actorUserId, createdAt, input.repositoryId, input.organizationId, input.expectedRevision,
          input.repositoryId, input.organizationId, input.organizationId, input.actorUserId)
        .first<Record<string, unknown>>();
      return row ? consentFromRow(row) : null;
    },
  };
}

export type ManagedExecutionConsentOutcome<T> = { ok: true; data: T } | { ok: false; error: "unauthorized" | "forbidden" | "not_found" | "invalid_consent" | "revision_conflict" };

export async function readManagedExecutionConsent(product: ProductStore, consents: ManagedExecutionConsentStore, userId: string, organizationId: string, repositoryId: string): Promise<ManagedExecutionConsentOutcome<{ current: ManagedExecutionConsent; history: ManagedExecutionConsent[]; canEdit: boolean }>> {
  const membership = await product.getMembership(organizationId, userId);
  if (!membership) return { ok: false, error: "unauthorized" };
  const repository = await product.getRepository(repositoryId);
  if (!repository || repository.organizationId !== organizationId) return { ok: false, error: "not_found" };
  const [current, history] = await Promise.all([consents.current(organizationId, repositoryId), consents.history(organizationId, repositoryId)]);
  return { ok: true, data: { current, history, canEdit: canChangeManagedExecution(membership.role) } };
}

export async function updateManagedExecutionConsent(product: ProductStore, consents: ManagedExecutionConsentStore, userId: string, organizationId: string, repositoryId: string, body: unknown): Promise<ManagedExecutionConsentOutcome<ManagedExecutionConsent>> {
  const membership = await product.getMembership(organizationId, userId);
  if (!membership) return { ok: false, error: "unauthorized" };
  if (!canChangeManagedExecution(membership.role)) return { ok: false, error: "forbidden" };
  const repository = await product.getRepository(repositoryId);
  if (!repository || repository.organizationId !== organizationId) return { ok: false, error: "not_found" };
  const value = body as { expectedRevision?: unknown; mode?: unknown; maxDurationSeconds?: unknown } | null;
  if (!value || typeof value.expectedRevision !== "number" || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0 ||
      (value.mode !== "observation_only" && value.mode !== "verification") || typeof value.maxDurationSeconds !== "number") {
    return { ok: false, error: "invalid_consent" };
  }
  const draft: ManagedExecutionConsent = { organizationId, repositoryId, mode: value.mode, revision: value.expectedRevision,
    maxDurationSeconds: value.maxDurationSeconds, ...(value.mode === "verification" ? { consentedByUserId: userId, consentedAt: new Date().toISOString() } : {}) };
  if (validateManagedExecutionConsent(draft)) return { ok: false, error: "invalid_consent" };
  const stored = await consents.append({ organizationId, repositoryId, actorUserId: userId, expectedRevision: value.expectedRevision, mode: value.mode, maxDurationSeconds: value.maxDurationSeconds });
  return stored ? { ok: true, data: stored } : { ok: false, error: "revision_conflict" };
}
