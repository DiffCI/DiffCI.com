/**
 * Reports DEPLOYMENT FRESHNESS: does the deployed shadow Worker's analyzer match the current main
 * revision? (2026-08-26)
 *
 * Deliberately SEPARATE from sourceIntegrity, and must stay that way. Those are different conditions:
 *
 *   sourceIntegrity  - does the deployed Worker's EXPECTED_SOURCE_SHA match the UPLOADED SOURCE ARCHIVE?
 *                      Both are stamped by the same deploy, so a later commit on main leaves this
 *                      CURRENT. It answers "is the running analyzer the code it claims to be?"
 *   freshness (here) - does that deployed SHA still equal main's HEAD? It answers "is the running
 *                      analyzer the code we currently believe in?"
 *
 * Conflating them was a real mistake made on 2026-08-26: a commit to main was said to risk pausing
 * observation. It does not. Overloading sourceIntegrity with freshness would have made a correct,
 * load-bearing guard mean two things at once, and the next person to read it would have had to guess
 * which.
 *
 * A stale deployment is not an incident - it is ordinary lag, and STALE_DEPLOYMENT exits 0 by default so
 * this can be run informationally. Pass --strict to make it exit non-zero, for use in a release check
 * where analysing behind-main code genuinely matters.
 *
 * Usage: npx tsx scripts/check-deployment-freshness.ts [--url <worker>] [--strict]
 *   RESEARCH_DISPATCH_TOKEN required.
 */
import { execSync } from "node:child_process";

const DEFAULT_URL = "https://diffci-research-sandbox.damp-waterfall-0cd8.workers.dev";

async function main() {
  const args: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--strict") args.strict = "true";
    else if (a?.startsWith("--")) args[a.slice(2)] = argv[++i] ?? "";
  }
  const url = args.url || process.env.DIFFCI_RESEARCH_SANDBOX_URL || DEFAULT_URL;
  const token = process.env.RESEARCH_DISPATCH_TOKEN;
  if (!token) throw new Error("RESEARCH_DISPATCH_TOKEN required");

  const res = await fetch(`${url.replace(/\/$/, "")}/v1/shadow/cron-status?limit=1`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`cron-status ${res.status}`);
  const status = (await res.json()) as { cronEnabled?: boolean; sourceIntegrity?: { status?: string; expectedSha?: string } };

  const deployedSha = status.sourceIntegrity?.expectedSha;
  const integrity = status.sourceIntegrity?.status;
  const mainSha = execSync("git rev-parse main", { encoding: "utf8" }).trim();

  const fresh = deployedSha === mainSha;
  let behind = "unknown";
  if (deployedSha && !fresh) {
    try {
      behind = execSync(`git rev-list --count ${deployedSha}..main`, { encoding: "utf8" }).trim();
    } catch {
      // deployed SHA not present locally (e.g. shallow clone) - the count is unavailable, which is
      // reported as such rather than guessed at.
      behind = "unavailable";
    }
  }

  console.log(`sourceIntegrity:     ${integrity ?? "unknown"}   (analyzer matches its own archive)`);
  console.log(`cronEnabled:         ${status.cronEnabled ?? "unknown"}`);
  console.log(`deployedSha:         ${deployedSha?.slice(0, 12) ?? "unknown"}`);
  console.log(`mainSha:             ${mainSha.slice(0, 12)}`);
  console.log(`freshness:           ${fresh ? "FRESH" : "STALE_DEPLOYMENT"}${fresh ? "" : ` (main is ${behind} commit(s) ahead)`}`);
  if (!fresh) {
    console.log("");
    console.log("A stale deployment does NOT pause observation - sourceIntegrity is unaffected by main advancing.");
    console.log("It only means the autonomous system is analysing an older revision than main. Redeploy with:");
    console.log("  npx tsx scripts/deploy-research-sandbox.ts --url <worker> --label <note>");
  }

  if (!fresh && args.strict === "true") process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
