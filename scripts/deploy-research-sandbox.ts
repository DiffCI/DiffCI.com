/**
 * Canonical deploy pipeline for the diffci-research-sandbox Worker (2026-08-21 source-integrity fix).
 * Replaces the previously-manual, easy-to-forget sequence of "deploy the Worker" + "remember to also run
 * npm run shadow:upload-source" - the exact gap that let the autonomous shadow-cron silently keep
 * running commit e58fdfb's code while `main` moved 4 commits past it (see docs/CURRENT_STATE.md and
 * docs/research/2026-08-21-shadow-source-integrity-fix.md for the incident this closes).
 *
 * Pipeline, in order, each step gating the next:
 *   1. Refuse a dirty working tree - the packaged source must be exactly what its SHA claims.
 *   2. npm run typecheck
 *   3. npm run test
 *   4. Deploy the Worker with `wrangler deploy --var EXPECTED_SOURCE_SHA:<HEAD>` - this is what makes the
 *      deployed Worker's own idea of "the expected source" equal the same commit, without ever writing a
 *      SHA into the checked-in wrangler.research-sandbox.jsonc (which would itself go stale the moment of
 *      the next commit - see that file's comment).
 *   5. Package the source tree + upload it to R2, tagged with the real HEAD SHA (scripts/shadow-source-lib.ts)
 *   6. Verify: GET /v1/shadow/cron-status and require sourceIntegrity.status === "CURRENT" with both
 *      expectedSha and archiveSha equal to the HEAD SHA this run packaged. Anything else exits non-zero -
 *      a deploy that can't PROVE the invariant holds is a failed deploy, not a "probably fine" one.
 *
 * Order rationale (Worker-first, THEN archive) - this is load-bearing, not cosmetic, discovered live
 * running this exact script: POST /v1/shadow/source is itself served by the deployed Worker code, so
 * uploading BEFORE deploying hits the OLD handler - which, across a change to the upload
 * endpoint/metadata shape itself (exactly what this fix is), can silently accept/ignore fields the new
 * code needs (sourceSha/archiveHash), leaving a stale-shaped meta object behind even though the upload
 * "succeeded". Deploying first means every upload this script performs always hits the NEW handler.
 * The residual risk this ordering does carry - the Worker briefly expects a SHA no archive has yet
 * (between step 4 and step 5) - is safe by construction: computeSourceIntegrity reports that window as
 * MISSING/STALE (fails closed, autonomous polling simply pauses) rather than CURRENT-but-wrong, and it's
 * only as long as the upload call itself takes.
 *
 * Usage: npx tsx scripts/deploy-research-sandbox.ts --url https://<worker-host> [--label <note>] [--skip-checks]
 *   RESEARCH_DISPATCH_TOKEN environment variable required (never a CLI arg).
 *   --skip-checks skips typecheck/test (loudly warned) - for a genuine emergency re-deploy only; never
 *   the default path, and CI should never need it.
 */
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { currentHeadSha, isWorkingTreeDirty, packageSource, uploadPackagedSource } from "./shadow-source-lib.js";

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--skip-checks") {
      args["skip-checks"] = "true";
      continue;
    }
    if (arg?.startsWith("--")) args[arg.slice(2)] = argv[++i] ?? "";
  }
  return args;
}

function run(command: string, cwd: string): void {
  console.log(`\n$ ${command}`);
  execSync(command, { cwd, stdio: "inherit" });
}

interface CronStatus {
  ok: boolean;
  cronEnabled?: boolean;
  sourceIntegrity?: { status: string; expectedSha?: string; archiveSha?: string; archiveHash?: string; uploadedAt?: string; detail: string };
}

async function fetchCronStatus(url: string, token: string): Promise<CronStatus | undefined> {
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/v1/shadow/cron-status?limit=1`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return undefined;
    return (await res.json()) as CronStatus;
  } catch {
    return undefined;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = args.url || process.env.DIFFCI_RESEARCH_SANDBOX_URL;
  const token = process.env.RESEARCH_DISPATCH_TOKEN;
  if (!url) throw new Error("--url (or DIFFCI_RESEARCH_SANDBOX_URL) required - the deployed diffci-research-sandbox Worker URL");
  if (!token) throw new Error("RESEARCH_DISPATCH_TOKEN environment variable required");
  const repoRoot = resolve(import.meta.dirname, "..");

  // Step 1: validate.
  if (isWorkingTreeDirty(repoRoot)) {
    throw new Error(
      "working tree has uncommitted changes - the canonical deploy path always packages an exact commit, " +
        "never a working-tree snapshot that could silently diverge from its own claimed SHA. Commit first.",
    );
  }

  // Sanity baseline before touching anything - lets the final verification also confirm this deploy
  // didn't accidentally wipe unrelated vars (SHADOW_CRON_ENABLED/DIFFCI_RESEARCH_ENABLED), which a
  // misused `wrangler deploy --var` flag could in principle do.
  const before = await fetchCronStatus(url, token);

  // Steps 2-3: typecheck/tests.
  if (args["skip-checks"] === "true") {
    console.warn("\n!!! --skip-checks passed - typecheck/test SKIPPED. Only use this for a genuine emergency redeploy. !!!\n");
  } else {
    run("npm run typecheck", repoRoot);
    run("npm run test", repoRoot);
  }

  // Step 4: deploy the Worker FIRST, stamping EXPECTED_SOURCE_SHA for THIS commit via --var (never
  // written into wrangler.research-sandbox.jsonc itself - see that file's comment on why a static value
  // there would be self-defeating). Must precede the upload below - see the module doc comment's "Order
  // rationale" for why archive-first was tried and found to be actually broken, not just riskier.
  const headSha = currentHeadSha(repoRoot);
  run(`npx wrangler deploy --config wrangler.research-sandbox.jsonc --var EXPECTED_SOURCE_SHA:${headSha}`, repoRoot);

  // Step 5: package + upload, tagged with the real HEAD SHA - now guaranteed to hit the Worker code
  // just deployed above.
  const packaged = packageSource(repoRoot);
  console.log(`\npackaged source: sourceSha=${packaged.sourceSha} archiveHash=${packaged.archiveHash.slice(0, 16)}... size=${(packaged.sizeBytes / 1024 / 1024).toFixed(2)}MB`);
  if (packaged.sourceSha !== headSha) {
    // The working tree changed between step 4's git-read and step 5's packaging (e.g. another process
    // committed concurrently) - refuse rather than deploy a Worker that expects one SHA while uploading
    // a different one under its nose.
    packaged.cleanup();
    throw new Error(`HEAD changed mid-deploy: Worker was deployed expecting ${headSha}, but packaging now sees ${packaged.sourceSha} - re-run the deploy.`);
  }
  try {
    const upload = await uploadPackagedSource({ url, token, packaged, label: args.label });
    if (!upload.ok) throw new Error(`source upload failed: ${upload.error}`);
    console.log(`source uploaded: ${JSON.stringify(upload)}`);

    // Step 6: verify. Retries for eventual-consistency propagation - live-observed running this exact
    // script: a fresh `wrangler deploy --var` env-var change can take up to ~20-30s to actually be
    // visible to a request hitting the edge, even though the deploy command itself already returned and
    // the R2 upload immediately after it succeeds. 12 attempts * 3s = up to 36s total.
    let status: CronStatus | undefined;
    for (let attempt = 1; attempt <= 12; attempt++) {
      status = await fetchCronStatus(url, token);
      if (status?.sourceIntegrity?.status === "CURRENT" && status.sourceIntegrity.expectedSha === packaged.sourceSha) break;
      if (attempt < 12) await sleep(3000);
    }

    if (!status?.ok) {
      throw new Error("verification failed: could not reach GET /v1/shadow/cron-status after deploy (see network/auth errors above)");
    }
    const integrity = status.sourceIntegrity;
    if (integrity?.status !== "CURRENT" || integrity.expectedSha !== packaged.sourceSha || integrity.archiveSha !== packaged.sourceSha) {
      throw new Error(
        `verification failed: expected sourceIntegrity CURRENT with expectedSha=archiveSha=${packaged.sourceSha}, ` +
          `got ${JSON.stringify(integrity)} - the deploy did NOT establish the invariant. Do not consider this deploy done.`,
      );
    }
    if (before?.ok && before.cronEnabled !== undefined && status.cronEnabled !== before.cronEnabled) {
      console.warn(`\n!!! WARNING: cronEnabled changed from ${before.cronEnabled} to ${status.cronEnabled} across this deploy - check wrangler.research-sandbox.jsonc's vars weren't unintentionally altered. !!!\n`);
    }

    console.log(
      `\n✔ deploy verified: expected SHA == archive SHA == ${packaged.sourceSha}, sourceIntegrity.status=CURRENT\n` +
        `  Repository HEAD:      ${packaged.sourceSha}\n` +
        `  Deployed Worker URL:  ${url}\n`,
    );
  } finally {
    packaged.cleanup();
  }
}

main().catch((error) => {
  console.error(`\n✘ deploy FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
