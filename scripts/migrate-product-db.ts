/**
 * Deterministic, ordered migration runner for the diffci-product D1 database (Part 2/3 of the SaaS
 * Foundation Stage 3 build). Replaces "manually execute several SQL files in arbitrary order" with one
 * fixed, documented sequence - every file here uses CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT
 * EXISTS (idempotent, safe to re-run), and the ORDER matters because later files' foreign keys reference
 * earlier files' tables (documented per-file below and in each schema.sql's own header comment).
 *
 * This intentionally does NOT introduce a general-purpose migration framework (no down-migrations, no
 * migration-version table) - matching the precedent already set by src/research/cloudflare's own
 * schema-migration-*.sql files, which are applied the same way (`wrangler d1 execute ... --file=...`,
 * manually sequenced by filename date). This script's contribution is making that sequence a single
 * reproducible command instead of a manually-remembered list, for the NEW product database specifically.
 *
 * Usage:
 *   npx tsx scripts/migrate-product-db.ts --remote   # applies to the real diffci-product D1 database
 *   npx tsx scripts/migrate-product-db.ts --local     # applies to wrangler's local D1 emulation (dev/test)
 *
 * Requires wrangler.product.jsonc to exist (created alongside this script) with a `diffci_product`
 * D1 binding whose database_name is "diffci-product".
 */
import { execFileSync } from "node:child_process";

// Fixed order - each entry's comment states the dependency reason it must come after the previous ones.
const MIGRATION_FILES = [
  "src/product/cloudflare/schema.sql", // base: users, organizations, organization_members, repositories, audit_log - no dependencies
  "src/billing/cloudflare/schema.sql", // billing_customers/subscriptions/billing_events reference organizations(id)
  "src/auth/cloudflare/schema.sql", // sessions references users(id)
  "src/auth/cloudflare/schema-oauth.sql", // provider_identities references users(id); oauth_states has no FK
  "src/usage/cloudflare/schema.sql", // usage_events references organizations(id), repositories(id)
  "src/runner/cloudflare/schema.sql", // runners references organizations(id), repositories(id)
  "src/execution-queue/cloudflare/schema.sql", // execution_queue_items references organizations(id), repositories(id), runners(id)
  "src/ingest/cloudflare/schema.sql", // ingest_tokens/observations reference organizations(id), repositories(id), users(id)
  "src/billing/cloudflare/schema-metered-invoices.sql", // invoices/invoice_lines reference organizations(id), repositories(id)
];

function run(): void {
  const mode = process.argv.includes("--remote") ? "--remote" : process.argv.includes("--local") ? "--local" : undefined;
  if (!mode) {
    console.error("Usage: npx tsx scripts/migrate-product-db.ts --remote|--local");
    process.exit(1);
  }

  console.log(`Applying ${MIGRATION_FILES.length} migration files to diffci-product (${mode})...`);
  for (const file of MIGRATION_FILES) {
    console.log(`  -> ${file}`);
    execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", ["wrangler", "d1", "execute", "diffci-product", mode, `--file=${file}`, "--config", "wrangler.product.jsonc"], {
      stdio: "inherit",
    });
  }
  console.log("Migration complete.");
}

run();
