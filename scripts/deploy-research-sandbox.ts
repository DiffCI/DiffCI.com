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
 *   4. Package the source tree + upload it to R2, tagged with the real HEAD SHA (scripts/shadow-source-lib.ts)
 *   5. Deploy the Worker with `wrangler deploy --var EXPECTED_SOURCE_SHA:<HEAD>` - this is what makes the
 *      deployed Worker's own idea of "the expected source" equal the same commit, without ever writing a
 *      SHA into the checked-in wrangler.research-sandbox.jsonc (which would itself go stale the moment of
 *      the next commit - see that file's comment).
 *   6. Verify: GET /v1/shadow/cron-status and require sourceIntegrity.status === "CURRENT" with both
 *      expectedSha and archiveSha equal to the HEAD SHA this run packaged. Anything else exits non-zero -
 *      a deploy that can't PROVE the invariant holds is a failed deploy, not a "probably fine" one.
 *
 * Order rationale (archive-before-Worker): between step 4 and step 5 completing, the Worker still expects
 * the OLD SHA while the NEW archive already exists in R2 - computeSourceIntegrity reports that as STALE
 * (fails closed, autonomous polling simply pauses for that window) rather than CURRENT-but-wrong either
 * way, so this ordering is safe; it's chosen only because it keeps the STALE window as short as possible
 * (just the wrangler deploy call) rather than for correctness - see shadow-source-integrity.ts.
 *
 * Usage: npx tsx scripts/deploy-research-sandbox.ts --url https://<worker-host> [--label <note>] [--skip-checks]
 *   RESEARCH_DISPATCH_TOKEN environment variable required (never a CLI arg).
 *   --skip-checks skips typecheck/test (loudly warned) - for a genuine emergency re-deploy only; never
 *   the default path, and CI should never need it.
 */
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { isWorkingTreeDirty, packageSource, uploadPackagedSource } from "./shadow-source-lib.js";

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

  // Step 4: package + upload, tagged with the real HEAD SHA.
  const packaged = packageSource(repoRoot);
  console.log(`\npackaged source: sourceSha=${packaged.sourceSha} archiveHash=${packaged.archiveHash.slice(0, 16)}... size=${(packaged.sizeBytes / 1024 / 1024).toFixed(2)}MB`);
  try {
    const upload = await uploadPackagedSource({ url, token, packaged, label: args.label });
    if (!upload.ok) throw new Error(`source upload failed: ${upload.error}`);
    console.log(`source uploaded: ${JSON.stringify(upload)}`);

    // Step 5: deploy the Worker, stamping EXPECTED_SOURCE_SHA for THIS commit via --var (never written
    // into wrangler.research-sandbox.jsonc itself - see that file's comment on why a static value there
    // would be self-defeating).
    run(`npx wrangler deploy --config wrangler.research-sandbox.jsonc --var EXPECTED_SOURCE_SHA:${packaged.sourceSha}`, repoRoot);

    // Step 6: verify. A short retry allows for eventual-consistency propagation of the new Worker
    // version/vars; this is not expected to need more than one attempt in practice.
    let status: CronStatus | undefined;
    for (let attempt = 1; attempt <= 5; attempt++) {
      status = await fetchCronStatus(url, token);
      if (status?.sourceIntegrity?.status === "CURRENT" && status.sourceIntegrity.expectedSha === packaged.sourceSha) break;
      if (attempt < 5) await sleep(2000);
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
