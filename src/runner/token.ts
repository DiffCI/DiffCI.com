/**
 * Short-lived, runner-scoped, job-scoped, single-use credentials (R1 Part 12) a real ephemeral runner
 * uses to authenticate to DiffCI's own control plane - distinct from the GitHub App installation token
 * (Preflight/shadow, external API calls) and distinct from the old shared RUNNER_CONTROL_TOKEN the
 * original synchronous Cloudflare Containers provider still uses (one long-lived Worker-wide secret,
 * not per-runner). Only the SHA-256 hash of the raw token is ever persisted - same hashing primitive as
 * src/auth/sessions.ts's hashSessionToken/generateSessionToken, reused rather than reinvented (R1 Part
 * 12's own note: "a directly-reusable building block already exists").
 *
 * verifyAndConsumeToken() is deliberately two-phase (verify() is read-only; claim()/submitResult() each
 * do their own single-use enforcement via a conditional UPDATE) rather than one "verify-and-mark-used"
 * call, because a real runner legitimately calls back multiple times with the SAME token across its
 * lifetime (register, one or more heartbeats, claim, result) - only claim and result carry their own
 * independent single-use semantics (Part 28: "wrong job claim", "duplicate result").
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

export interface RunnerTokenRecord {
  id: string;
  runnerId: string;
  jobId: string;
  organizationId: string;
  createdAt: string;
  expiresAt: string;
  claimedAt?: string;
  resultSubmittedAt?: string;
  revokedAt?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Same primitive as src/auth/sessions.ts - SHA-256 hex, the token itself IS the secret. */
export async function hashRunnerToken(rawToken: string): Promise<string> {
  const digestBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawToken));
  return Array.from(new Uint8Array(digestBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 256 bits of randomness, base64url - returned to the caller exactly once, never persisted or logged
 * in raw form anywhere (grep this codebase for "runner_token"/"runnerCredential" logging before adding
 * any new log line near this - R1 Part 11's own requirement). */
export function generateRunnerToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function rowToRecord(row: Record<string, unknown>): RunnerTokenRecord {
  return {
    id: row.id as string,
    runnerId: row.runner_id as string,
    jobId: row.job_id as string,
    organizationId: row.organization_id as string,
    createdAt: row.created_at as string,
    expiresAt: row.expires_at as string,
    claimedAt: (row.claimed_at as string | null) ?? undefined,
    resultSubmittedAt: (row.result_submitted_at as string | null) ?? undefined,
    revokedAt: (row.revoked_at as string | null) ?? undefined,
  };
}

export type TokenVerifyFailure = "not_found" | "expired" | "revoked";

export interface RunnerTokenStore {
  /** Mints a new token for exactly one (runner, job) pair. Returns the RAW token once - the caller is
   * responsible for getting it to the runner (as an injected env var) and never persisting/logging it. */
  issueToken(input: { runnerId: string; jobId: string; organizationId: string; ttlMs: number }): Promise<{ raw: string; record: RunnerTokenRecord }>;
  /** Read-only lookup by raw token - does NOT consume/mark anything. Returns the failure reason
   * explicitly rather than a bare null, so callers (and tests) can distinguish "never existed" from
   * "existed but expired" from "existed but revoked" - Part 28's controlled-failure cases need this. */
  verify(rawToken: string): Promise<{ ok: true; record: RunnerTokenRecord } | { ok: false; reason: TokenVerifyFailure }>;
  /** Single-use claim: succeeds exactly once per token (an atomic conditional UPDATE - claimed_at IS
   * NULL - so a race between two concurrent claim attempts with the SAME token can only let one
   * through, never both). Returns false on a replay/second attempt, never throws. */
  markClaimed(rawToken: string): Promise<boolean>;
  /** Single-use result submission, same conditional-UPDATE pattern as markClaimed. A duplicate result
   * callback (Part 28) is a safe, detectable no-op, not a silent double-write. */
  markResultSubmitted(rawToken: string): Promise<boolean>;
  /** Revokes a token before it was ever used (e.g. the runner never came up in time - provisioning
   * timeout, Part 19) - a revoked token fails verify() from then on regardless of expiry. */
  revoke(rawToken: string): Promise<void>;
}

export function makeD1RunnerTokenStore(db: D1Binding): RunnerTokenStore {
  return {
    async issueToken({ runnerId, jobId, organizationId, ttlMs }) {
      const raw = generateRunnerToken();
      const hash = await hashRunnerToken(raw);
      const id = crypto.randomUUID();
      const createdAt = nowIso();
      const expiresAt = new Date(Date.now() + ttlMs).toISOString();
      await db
        .prepare(`INSERT INTO runner_tokens (id, runner_id, job_id, organization_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, runnerId, jobId, organizationId, hash, createdAt, expiresAt)
        .run();
      return { raw, record: { id, runnerId, jobId, organizationId, createdAt, expiresAt } };
    },

    async verify(rawToken) {
      const hash = await hashRunnerToken(rawToken);
      const row = await db.prepare(`SELECT * FROM runner_tokens WHERE token_hash = ?`).bind(hash).first<Record<string, unknown>>();
      if (!row) return { ok: false, reason: "not_found" };
      const record = rowToRecord(row);
      if (record.revokedAt) return { ok: false, reason: "revoked" };
      if (record.expiresAt < nowIso()) return { ok: false, reason: "expired" };
      return { ok: true, record };
    },

    async markClaimed(rawToken) {
      const hash = await hashRunnerToken(rawToken);
      const ts = nowIso();
      const result = await db
        .prepare(`UPDATE runner_tokens SET claimed_at = ? WHERE token_hash = ? AND claimed_at IS NULL AND revoked_at IS NULL AND expires_at >= ?`)
        .bind(ts, hash, ts)
        .run();
      return (result.meta?.changes ?? 0) > 0;
    },

    async markResultSubmitted(rawToken) {
      const hash = await hashRunnerToken(rawToken);
      const ts = nowIso();
      const result = await db.prepare(`UPDATE runner_tokens SET result_submitted_at = ? WHERE token_hash = ? AND result_submitted_at IS NULL`).bind(ts, hash).run();
      return (result.meta?.changes ?? 0) > 0;
    },

    async revoke(rawToken) {
      const hash = await hashRunnerToken(rawToken);
      await db.prepare(`UPDATE runner_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`).bind(nowIso(), hash).run();
    },
  };
}
