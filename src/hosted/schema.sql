CREATE TABLE IF NOT EXISTS hosted_request_limits (
  bucket TEXT NOT NULL,
  window INTEGER NOT NULL,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (bucket, window)
);
CREATE INDEX IF NOT EXISTS idx_hosted_limits_expiry ON hosted_request_limits(expires_at);

CREATE TABLE IF NOT EXISTS public_diagnostic_jobs (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  repository TEXT NOT NULL,
  consent_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','running','complete','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT,
  lease_until INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  result_json TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_diagnostic_queue ON public_diagnostic_jobs(state, created_at);
CREATE INDEX IF NOT EXISTS idx_diagnostic_expiry ON public_diagnostic_jobs(expires_at);
