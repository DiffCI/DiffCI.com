-- Durable analytics delivery. No raw GitHub payloads or credentials are stored here.
CREATE TABLE IF NOT EXISTS shadow_analytics_outbox (
  event_key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS shadow_analytics_pending ON shadow_analytics_outbox(sent_at, created_at);
