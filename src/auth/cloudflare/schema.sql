-- Auth schema, same diffci-product D1 database as src/product + src/billing (applied after both -
-- references organizations.md's users(id) from src/product/cloudflare/schema.sql).
--
-- Apply with: wrangler d1 execute diffci-product --remote --file=src/auth/cloudflare/schema.sql

-- Never stores a raw bearer/cookie token (Part 4) - only its SHA-256 hash. A session row with a leaked
-- hashed_token is not directly usable to authenticate (the raw token cannot be recovered from the hash),
-- unlike a row storing the raw token would be.
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,      -- UUID (crypto.randomUUID())
  user_id TEXT NOT NULL REFERENCES users(id),
  hashed_token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
