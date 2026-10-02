import type { D1Binding, ProductStore } from "./store.js";

/** Reporting thresholds only. No policy can authorize selective execution. */
export interface EvidencePolicy {
  windowDays: number;
  maxObservationAgeHours: number;
  minimumPredictions: number;
  minimumVerifiedPredictions: number;
  minimumEvaluableFailures: number;
}

export const DEFAULT_EVIDENCE_POLICY: Readonly<EvidencePolicy> = Object.freeze({
  windowDays: 7, maxObservationAgeHours: 48, minimumPredictions: 10,
  minimumVerifiedPredictions: 5, minimumEvaluableFailures: 1,
});

export interface PolicyRevision {
  revision: number;
  policy: EvidencePolicy;
  actorUserId: string | null;
  createdAt: string | null;
}

export function parseEvidencePolicy(value: unknown): EvidencePolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const limits: Record<keyof EvidencePolicy, [number, number]> = {
    windowDays: [1, 90], maxObservationAgeHours: [1, 2160], minimumPredictions: [1, 100000],
    minimumVerifiedPredictions: [1, 100000], minimumEvaluableFailures: [1, 100000],
  };
  if (Object.keys(record).length !== Object.keys(limits).length) return null;
  for (const [key, [min, max]] of Object.entries(limits)) {
    const number = record[key];
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < min || number > max) return null;
  }
  if (Number(record.minimumVerifiedPredictions) > Number(record.minimumPredictions)) return null;
  return { ...record } as unknown as EvidencePolicy;
}

export interface EvidencePolicyStore {
  current(organizationId: string): Promise<PolicyRevision>;
  history(organizationId: string): Promise<PolicyRevision[]>;
  append(organizationId: string, actorUserId: string, expectedRevision: number, policy: EvidencePolicy): Promise<PolicyRevision | null>;
}

function fromRow(row: Record<string, unknown>): PolicyRevision {
  const policy = parseEvidencePolicy(JSON.parse(String(row.policy_json)));
  if (!policy) throw new Error("Invalid stored evidence policy");
  return { revision: Number(row.revision), policy, actorUserId: String(row.actor_user_id), createdAt: String(row.created_at) };
}

export function makeD1EvidencePolicyStore(db: D1Binding): EvidencePolicyStore {
  return {
    async current(organizationId) {
      const row = await db.prepare("SELECT * FROM organization_evidence_policies WHERE organization_id = ? ORDER BY revision DESC LIMIT 1")
        .bind(organizationId).first<Record<string, unknown>>();
      return row ? fromRow(row) : { revision: 0, policy: { ...DEFAULT_EVIDENCE_POLICY }, actorUserId: null, createdAt: null };
    },
    async history(organizationId) {
      const { results } = await db.prepare("SELECT * FROM organization_evidence_policies WHERE organization_id = ? ORDER BY revision DESC LIMIT 100")
        .bind(organizationId).all<Record<string, unknown>>();
      return results.map(fromRow);
    },
    async append(organizationId, actorUserId, expectedRevision, policy) {
      const createdAt = new Date().toISOString();
      // One atomic append is both the state change and its audit record. A stale editor cannot
      // overwrite a newer revision. Authorization is rechecked inside the write statement.
      const row = await db.prepare(`INSERT INTO organization_evidence_policies
        (organization_id, revision, policy_json, actor_user_id, created_at)
        SELECT ?, ?, ?, ?, ? WHERE
          COALESCE((SELECT MAX(revision) FROM organization_evidence_policies WHERE organization_id = ?), 0) = ?
          AND EXISTS (SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ? AND role IN ('owner', 'admin'))
        ON CONFLICT(organization_id, revision) DO NOTHING RETURNING *`)
        .bind(organizationId, expectedRevision + 1, JSON.stringify(policy), actorUserId, createdAt,
          organizationId, expectedRevision, organizationId, actorUserId).first<Record<string, unknown>>();
      return row ? fromRow(row) : null;
    },
  };
}

export type PolicyOutcome<T> = { ok: true; data: T } | { ok: false; error: "unauthorized" | "forbidden" | "invalid_policy" | "revision_conflict" };

export async function readEvidencePolicy(product: ProductStore, policies: EvidencePolicyStore, userId: string, organizationId: string): Promise<PolicyOutcome<{ current: PolicyRevision; history: PolicyRevision[]; canEdit: boolean }>> {
  const membership = await product.getMembership(organizationId, userId);
  if (!membership) return { ok: false, error: "unauthorized" };
  const [current, history] = await Promise.all([policies.current(organizationId), policies.history(organizationId)]);
  return { ok: true, data: { current, history, canEdit: membership.role === "owner" || membership.role === "admin" } };
}

export async function updateEvidencePolicy(product: ProductStore, policies: EvidencePolicyStore, userId: string, organizationId: string, body: unknown): Promise<PolicyOutcome<PolicyRevision>> {
  const membership = await product.getMembership(organizationId, userId);
  if (!membership) return { ok: false, error: "unauthorized" };
  if (membership.role !== "owner" && membership.role !== "admin") return { ok: false, error: "forbidden" };
  const input = body as { expectedRevision?: unknown; policy?: unknown } | null;
  const policy = parseEvidencePolicy(input?.policy);
  if (!policy || typeof input?.expectedRevision !== "number" || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || input.expectedRevision >= Number.MAX_SAFE_INTEGER) {
    return { ok: false, error: "invalid_policy" };
  }
  const result = await policies.append(organizationId, userId, input.expectedRevision, policy);
  return result ? { ok: true, data: result } : { ok: false, error: "revision_conflict" };
}
