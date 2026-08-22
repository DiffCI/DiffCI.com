/**
 * D1 persistence for oauth_states and provider_identities (src/auth/cloudflare/schema-oauth.sql).
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

function nowIso(): string {
  return new Date().toISOString();
}

export interface ProviderIdentity {
  userId: string;
  provider: "github";
  providerUserId: string;
  providerLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface OAuthStateRecord {
  state: string;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
  redirectTo?: string;
}

export interface OAuthStore {
  createState(ttlMs: number, redirectTo?: string): Promise<string>;
  /**
   * Atomically marks the state consumed and returns it, or returns null if the state does not exist,
   * is expired, or was already consumed (Part 11: state mismatch / replay / expired must all be
   * rejected the same way - null - so a caller cannot distinguish "never existed" from "already used"
   * from response shape alone).
   */
  consumeState(state: string): Promise<OAuthStateRecord | null>;

  linkProviderIdentity(userId: string, provider: "github", providerUserId: string, providerLogin: string): Promise<void>;
  /** Looked up by provider_user_id (GitHub's immutable numeric id), NEVER by provider_login (Part 7:
   * usernames can be renamed). */
  getUserIdForProviderIdentity(provider: "github", providerUserId: string): Promise<string | null>;
  /** Keeps provider_login current on every login, without changing the identity lookup key. */
  touchProviderLogin(provider: "github", providerUserId: string, providerLogin: string): Promise<void>;
}

export function makeD1OAuthStore(db: D1Binding): OAuthStore {
  return {
    async createState(ttlMs, redirectTo) {
      const state = Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const ts = nowIso();
      const expiresAt = new Date(Date.now() + ttlMs).toISOString();
      await db.prepare(`INSERT INTO oauth_states (state, created_at, expires_at, redirect_to) VALUES (?, ?, ?, ?)`).bind(state, ts, expiresAt, redirectTo ?? null).run();
      return state;
    },

    async consumeState(state) {
      const row = await db.prepare(`SELECT * FROM oauth_states WHERE state = ?`).bind(state).first<Record<string, unknown>>();
      if (!row) return null; // never existed - same outward result as "already used" or "expired"
      if (row.consumed_at) return null; // replay
      if (new Date(row.expires_at as string).getTime() <= Date.now()) return null; // expired

      // Mark consumed in the SAME call that reads it - there is no separate "check then use" window an
      // attacker could race, since D1/SQLite executes this UPDATE atomically and consumeState() is the
      // only place that ever sets consumed_at.
      const ts = nowIso();
      const result = await db.prepare(`UPDATE oauth_states SET consumed_at = ? WHERE state = ? AND consumed_at IS NULL`).bind(ts, state).run();
      if ((result.meta?.changes ?? 0) === 0) return null; // lost a race with a concurrent consumeState() call on the exact same state

      return { state: row.state as string, createdAt: row.created_at as string, expiresAt: row.expires_at as string, consumedAt: ts, redirectTo: (row.redirect_to as string | null) ?? undefined };
    },

    async linkProviderIdentity(userId, provider, providerUserId, providerLogin) {
      const ts = nowIso();
      await db
        .prepare(`INSERT INTO provider_identities (user_id, provider, provider_user_id, provider_login, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(userId, provider, providerUserId, providerLogin, ts, ts)
        .run();
    },

    async getUserIdForProviderIdentity(provider, providerUserId) {
      const row = await db.prepare(`SELECT user_id FROM provider_identities WHERE provider = ? AND provider_user_id = ?`).bind(provider, providerUserId).first<{ user_id: string }>();
      return row?.user_id ?? null;
    },

    async touchProviderLogin(provider, providerUserId, providerLogin) {
      await db.prepare(`UPDATE provider_identities SET provider_login = ?, updated_at = ? WHERE provider = ? AND provider_user_id = ?`).bind(providerLogin, nowIso(), provider, providerUserId).run();
    },
  };
}
