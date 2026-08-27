/**
 * Ingest credentials (Phase 03, 2026-08-26).
 *
 * A report arrives from a CI job: no human, no browser, no session cookie. The token it carries is the
 * only thing that can say which repository - and therefore which organization - it belongs to. So the
 * shape of the token is a tenancy decision, not a convenience:
 *
 *   - Scoped to ONE repository. An organization-wide token would make "which repository is this?" a
 *     claim the sender makes rather than a fact about the credential, and a claim is exactly what an
 *     attacker controls.
 *   - Hashed at rest (SHA-256 hex, same primitive as src/auth/sessions.ts and src/runner/token.ts). The
 *     raw value is returned exactly once, at creation.
 *   - Prefixed and self-identifying (`dci_...`). A token that looks like a token is one that secret
 *     scanners, `git grep` and a reviewer's eye can all catch when it ends up somewhere it should not.
 *   - Not expiring by default. A credential that silently dies mid-window looks like DiffCI breaking,
 *     during the exact seven days someone is deciding whether to trust it. Expiry is available and
 *     opt-in; revocation is immediate and always available.
 *
 * `last_used_at` exists so an owner can answer "is this thing live?" from the product rather than from
 * logs, and so a revoked-and-forgotten credential is visibly dead.
 */

export interface D1Binding {
  prepare(query: string): {
    bind(...values: unknown[]): {
      run(): Promise<{ meta?: { changes?: number } }>;
      all<T = unknown>(): Promise<{ results: T[] }>;
      first<T = unknown>(): Promise<T | null>;
    };
  };
}

export interface IngestTokenRecord {
  id: string;
  organizationId: string;
  repositoryId: string;
  /** Display-only: the leading characters of the raw token. Never enough to authenticate with. */
  tokenPrefix: string;
  name?: string;
  createdAt: string;
  createdByUserId?: string;
  lastUsedAt?: string;
  revokedAt?: string;
  expiresAt?: string;
}

/** Every raw ingest token starts with this, so it is recognisable anywhere it is pasted or leaked. */
export const INGEST_TOKEN_PREFIX = "dci_";

/** How much of the raw token is kept in the clear for display. Long enough to tell two apart. */
const DISPLAY_PREFIX_LENGTH = INGEST_TOKEN_PREFIX.length + 8;

function nowIso(): string {
  return new Date().toISOString();
}

export async function hashIngestToken(rawToken: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawToken));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** 256 bits of randomness, base64url, behind a recognisable prefix. */
export function generateIngestToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const body = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${INGEST_TOKEN_PREFIX}${body}`;
}

function rowToRecord(row: Record<string, unknown>): IngestTokenRecord {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    repositoryId: row.repository_id as string,
    tokenPrefix: row.token_prefix as string,
    name: (row.name as string | null) ?? undefined,
    createdAt: row.created_at as string,
    createdByUserId: (row.created_by_user_id as string | null) ?? undefined,
    lastUsedAt: (row.last_used_at as string | null) ?? undefined,
    revokedAt: (row.revoked_at as string | null) ?? undefined,
    expiresAt: (row.expires_at as string | null) ?? undefined,
  };
}

/** Distinguished so a caller can tell "never existed" from "existed but is dead" - and so the API can
 * say the same thing to the sender, who is usually a person debugging their own workflow. */
export type IngestTokenFailure = "not_found" | "revoked" | "expired" | "malformed";

export interface IngestTokenStore {
  /** Mints a credential for exactly one repository. The raw token is returned once and never again. */
  issue(input: {
    organizationId: string;
    repositoryId: string;
    name?: string;
    createdByUserId?: string;
    /** Optional, in milliseconds. Absent means the credential does not expire on its own. */
    ttlMs?: number;
  }): Promise<{ raw: string; record: IngestTokenRecord }>;

  /** Read-only verification. Does not record use - see markUsed, which an accepted ingest calls. */
  verify(rawToken: string): Promise<{ ok: true; record: IngestTokenRecord } | { ok: false; reason: IngestTokenFailure }>;

  /** Stamps last_used_at. Separate from verify() so a rejected report never makes a token look live. */
  markUsed(tokenId: string): Promise<void>;

  /**
   * Organization-scoped listing. The organizationId is a predicate on the query, not a filter applied
   * after the fact: a caller holding another organization's token id gets an empty list, not a row.
   */
  listForOrganization(organizationId: string): Promise<IngestTokenRecord[]>;
  listForRepository(organizationId: string, repositoryId: string): Promise<IngestTokenRecord[]>;

  /** Revocation is immediate and scoped: revoking requires knowing which organization owns the token. */
  revoke(organizationId: string, tokenId: string): Promise<boolean>;
}

export function makeD1IngestTokenStore(db: D1Binding): IngestTokenStore {
  return {
    async issue({ organizationId, repositoryId, name, createdByUserId, ttlMs }) {
      const raw = generateIngestToken();
      const hash = await hashIngestToken(raw);
      const id = crypto.randomUUID();
      const createdAt = nowIso();
      const expiresAt = ttlMs === undefined ? undefined : new Date(Date.now() + ttlMs).toISOString();
      const tokenPrefix = raw.slice(0, DISPLAY_PREFIX_LENGTH);
      await db
        .prepare(
          `INSERT INTO ingest_tokens (id, organization_id, repository_id, token_hash, token_prefix, name, created_at, created_by_user_id, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, organizationId, repositoryId, hash, tokenPrefix, name ?? null, createdAt, createdByUserId ?? null, expiresAt ?? null)
        .run();
      return {
        raw,
        record: { id, organizationId, repositoryId, tokenPrefix, name, createdAt, createdByUserId, expiresAt },
      };
    },

    async verify(rawToken) {
      // Rejected before hashing: a value that cannot be one of ours should not become a database
      // lookup, and the sender gets a message that names the actual problem.
      if (typeof rawToken !== "string" || !rawToken.startsWith(INGEST_TOKEN_PREFIX) || rawToken.length < DISPLAY_PREFIX_LENGTH) {
        return { ok: false, reason: "malformed" };
      }
      const hash = await hashIngestToken(rawToken);
      const row = await db.prepare(`SELECT * FROM ingest_tokens WHERE token_hash = ?`).bind(hash).first<Record<string, unknown>>();
      if (!row) return { ok: false, reason: "not_found" };
      const record = rowToRecord(row);
      if (record.revokedAt) return { ok: false, reason: "revoked" };
      if (record.expiresAt && record.expiresAt < nowIso()) return { ok: false, reason: "expired" };
      return { ok: true, record };
    },

    async markUsed(tokenId) {
      await db.prepare(`UPDATE ingest_tokens SET last_used_at = ? WHERE id = ?`).bind(nowIso(), tokenId).run();
    },

    async listForOrganization(organizationId) {
      const { results } = await db
        .prepare(`SELECT * FROM ingest_tokens WHERE organization_id = ? ORDER BY created_at DESC`)
        .bind(organizationId)
        .all<Record<string, unknown>>();
      return results.map(rowToRecord);
    },

    async listForRepository(organizationId, repositoryId) {
      const { results } = await db
        .prepare(`SELECT * FROM ingest_tokens WHERE organization_id = ? AND repository_id = ? ORDER BY created_at DESC`)
        .bind(organizationId, repositoryId)
        .all<Record<string, unknown>>();
      return results.map(rowToRecord);
    },

    async revoke(organizationId, tokenId) {
      const result = await db
        .prepare(`UPDATE ingest_tokens SET revoked_at = ? WHERE id = ? AND organization_id = ? AND revoked_at IS NULL`)
        .bind(nowIso(), tokenId, organizationId)
        .run();
      return (result.meta?.changes ?? 0) > 0;
    },
  };
}
