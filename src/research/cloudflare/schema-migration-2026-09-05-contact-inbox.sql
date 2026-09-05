-- 2026-09-05: a contact route for the public site that needs no mailbox. site/contact.html posts to
-- POST /v1/contact on the research Worker (public, size-limited); messages land here and the founder
-- reads them with GET /v1/contact/inbox (bearer). Nothing is emailed anywhere.
--
-- Apply:
--   npx wrangler d1 execute diffci-research --remote --config wrangler.research-sandbox.jsonc \
--     --file=src/research/cloudflare/schema-migration-2026-09-05-contact-inbox.sql

CREATE TABLE IF NOT EXISTS contact_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL,
  email TEXT,                 -- optional reply address, as typed
  repository TEXT,            -- optional owner/name, as typed
  message TEXT NOT NULL,      -- <= 4000 characters
  user_agent TEXT,
  read_at TEXT
);
