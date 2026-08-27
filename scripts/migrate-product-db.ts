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
export const MIGRATION_FILES = [
  "src/product/cloudflare/schema.sql", // base: users, organizations, organization_members, repositories, audit_log - no dependencies
  "src/billing/cloudflare/schema.sql", // billing_customers/subscriptions/billing_events reference organizations(id)
  "src/auth/cloudflare/schema.sql", // sessions references users(id)
  "src/auth/cloudflare/schema-oauth.sql", // provider_identities references users(id); oauth_states has no FK
  "src/usage/cloudflare/schema.sql", // usage_events references organizations(id), repositories(id)
  "src/runner/cloudflare/schema.sql", // runners references organizations(id), repositories(id)
  "src/execution-queue/cloudflare/schema.sql", // execution_queue_items references organizations(id), repositories(id), runners(id)
  "src/ingest/cloudflare/schema.sql", // ingest_tokens/observations reference organizations(id), repositories(id), users(id)
  "src/billing/cloudflare/schema-metered-invoices.sql", // invoices/invoice_lines reference organizations(id), repositories(id)
  "src/install/cloudflare/schema-installations.sql", // pending_installations references users(id), organizations(id); webhook_deliveries has no FK
];

/**
 * Every argument this script hands to a child process, so the shell-safety property below can be
 * asserted by a test rather than argued in a comment. Exported for exactly that reason.
 */
export const MIGRATION_ARGUMENT_LITERALS = ["wrangler", "d1", "execute", "diffci-product", "--remote", "--local", "--config", "wrangler.product.jsonc"] as const;

function run(): void {
  const mode = process.argv.includes("--remote") ? "--remote" : process.argv.includes("--local") ? "--local" : undefined;
  if (!mode) {
    console.error("Usage: npx tsx scripts/migrate-product-db.ts --remote|--local");
    process.exit(1);
  }

  console.log(`Applying ${MIGRATION_FILES.length} migration files to diffci-product (${mode})...`);
  for (const file of MIGRATION_FILES) {
    console.log(`  -> ${file}`);
    // shell:true on Windows because Node >=18.20/20.12 refuses to spawn a .cmd shim directly
    // (CVE-2024-27980) and throws EINVAL. Safe here: every argument below is a fixed literal or a
    // repo-relative path from MIGRATION_FILES above - none contain spaces or shell metacharacters.
    execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", ["wrangler", "d1", "execute", "diffci-product", mode, `--file=${file}`, "--config", "wrangler.product.jsonc"], {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
  }
  console.log("Migration complete.");
}

if (process.argv[1] && process.argv[1].endsWith("migrate-product-db.ts")) run();
