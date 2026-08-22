/**
 * D1 persistence for sessions (src/auth/cloudflare/schema.sql), same D1Binding idiom as the rest of the
 * codebase. hashSessionToken/generateSessionToken are exported separately from the store so
 * authenticate.ts can hash an incoming token without needing a D1Binding.
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

import type { Session } from "./types.js";

function nowIso(): string {
  return new Date().toISOString();
}

/** SHA-256 hex digest - deliberately not HMAC (there is no meaningful "secret key" for a session token
 * hash the way there is for a webhook signature; the token itself IS the secret, hashed for storage). */
export async function hashSessionToken(rawToken: string): Promise<string> {
  const digestBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawToken));
  return Array.from(new Uint8Array(digestBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 256 bits of randomness, base64url-encoded - the RAW token, returned to the caller exactly once (at
 * creation) and never persisted or logged in this form anywhere. */
export function generateSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function rowToSession(row: Record<string, unknown>): Session {
  return {
    sessionId: row.session_id as string,
    userId: row.user_id as string,
    hashedToken: row.hashed_token as string,
    createdAt: row.created_at as string,
    expiresAt: row.expires_at as string,
    lastUsedAt: row.last_used_at as string,
    revokedAt: (row.revoked_at as string | null) ?? undefined,
  };
}

export interface SessionStore {
  /** Returns the RAW token (caller must set it as an HttpOnly cookie / return it once) - never
   * retrievable again after this call returns. */
  createSession(userId: string, ttlMs: number): Promise<{ session: Session; rawToken: string }>;
  /** Looks up by the HASH of the presented token, never the raw token itself. Returns null for an
   * unknown, expired, or revoked session - callers must not distinguish these cases in any
   * externally-visible way (Part 23: "invalid/expired session rejected", same outcome either way). */
  getValidSessionByRawToken(rawToken: string): Promise<Session | null>;
  touchSession(sessionId: string): Promise<void>;
  revokeSession(sessionId: string): Promise<void>;
}

export function makeD1SessionStore(db: D1Binding): SessionStore {
  return {
    async createSession(userId, ttlMs) {
      const rawToken = generateSessionToken();
      const hashedToken = await hashSessionToken(rawToken);
      const sessionId = crypto.randomUUID();
      const ts = nowIso();
      const expiresAt = new Date(Date.now() + ttlMs).toISOString();
      await db
        .prepare(`INSERT INTO sessions (session_id, user_id, hashed_token, created_at, expires_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(sessionId, userId, hashedToken, ts, expiresAt, ts)
        .run();
      return { session: { sessionId, userId, hashedToken, createdAt: ts, expiresAt, lastUsedAt: ts }, rawToken };
    },

    async getValidSessionByRawToken(rawToken) {
      const hashedToken = await hashSessionToken(rawToken);
      const row = await db.prepare(`SELECT * FROM sessions WHERE hashed_token = ?`).bind(hashedToken).first<Record<string, unknown>>();
      if (!row) return null;
      const session = rowToSession(row);
      if (session.revokedAt) return null;
      if (new Date(session.expiresAt).getTime() <= Date.now()) return null;
      return session;
    },

    async touchSession(sessionId) {
      await db.prepare(`UPDATE sessions SET last_used_at = ? WHERE session_id = ?`).bind(nowIso(), sessionId).run();
    },

    async revokeSession(sessionId) {
      await db.prepare(`UPDATE sessions SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL`).bind(nowIso(), sessionId).run();
    },
  };
}
