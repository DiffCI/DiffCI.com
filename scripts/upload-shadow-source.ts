/**
 * Uploads the current diffci source tree as a tarball to the research Worker's R2 bucket
 * (POST /v1/shadow/source), where the autonomous shadow poller (shadow-cron.ts / the webhook's
 * push-triggered poll) pulls it for every scheduled/triggered poll, gated by source-version integrity
 * (2026-08-21 fix, src/research/cloudflare/shadow-source-integrity.ts). Run this after any change to
 * src/ or scripts/ that should be live in shadow polling - a poll's source SHA is always exactly the git
 * commit this script's `git rev-parse HEAD` names, never a manually chosen label.
 *
 * This is the LOW-LEVEL half of the deploy pipeline (packaging + upload only) - it does NOT deploy the
 * Worker or stamp EXPECTED_SOURCE_SHA, so running it alone against a Worker whose EXPECTED_SOURCE_SHA is
 * still the OLD commit will (correctly) leave source integrity STALE, not CURRENT, until the Worker is
 * also redeployed. Prefer `npm run shadow:deploy` (scripts/deploy-research-sandbox.ts), which does both
 * in the right order and verifies the result - use this script directly only for manual/debugging
 * re-uploads where you already know what you're doing.
 *
 * Usage: npx tsx scripts/upload-shadow-source.ts --url https://<worker-host> [--label <note>] [--allow-dirty]
 *   The bearer token is read from the RESEARCH_DISPATCH_TOKEN environment variable (never a CLI arg -
 *   argv is visible in process listings; same rule as the Worker's own GITHUB_TOKEN handling).
 */
import { resolve } from "node:path";
import { packageSource, uploadPackagedSource } from "./shadow-source-lib.js";

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--allow-dirty") {
      args["allow-dirty"] = "true";
      continue;
    }
    if (arg?.startsWith("--")) args[arg.slice(2)] = argv[++i] ?? "";
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = args.url || process.env.DIFFCI_RESEARCH_SANDBOX_URL;
  const token = process.env.RESEARCH_DISPATCH_TOKEN;
  if (!url) throw new Error("--url (or DIFFCI_RESEARCH_SANDBOX_URL) required - the deployed diffci-research-sandbox Worker URL");
  if (!token) throw new Error("RESEARCH_DISPATCH_TOKEN environment variable required");

  const repoRoot = resolve(import.meta.dirname, "..");
  const packaged = packageSource(repoRoot, { allowDirty: args["allow-dirty"] === "true" });
  try {
    console.log(`tarball: ${(packaged.sizeBytes / 1024 / 1024).toFixed(2)} MB, sourceSha=${packaged.sourceSha}, archiveHash=${packaged.archiveHash.slice(0, 16)}...`);
    const result = await uploadPackagedSource({ url, token, packaged, label: args.label });
    if (!result.ok) throw new Error(result.error ?? "upload failed");
    console.log(`uploaded: ${JSON.stringify(result)}`);
    console.log(
      "NOTE: this only uploads the archive. If the deployed Worker's EXPECTED_SOURCE_SHA doesn't already " +
        `match ${packaged.sourceSha}, GET /v1/shadow/cron-status will report sourceIntegrity.status STALE ` +
        "until the Worker is redeployed with that SHA (npm run shadow:deploy does both).",
    );
  } finally {
    packaged.cleanup();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
