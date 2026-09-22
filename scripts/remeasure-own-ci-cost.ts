/**
 * YC readiness Week 1 (2026-09-04) — re-measures "CI cost per job" and "CI wall time" for DiffCI's own CI
 * (docs/website/03-evidence-ledger.md's own required pre-publish step: these figures dated 2026-08-21 and
 * "the fleet has changed since" — the test suite alone has roughly quadrupled in that window).
 *
 * Reads the real, most recent completed `check` job durations from the real GitHub Actions API (via `gh`,
 * already authenticated in this environment — no new credential plumbing), and prices them with
 * createCloudflareContainersStandard2CostModel() (src/usage/cost-model.ts) — the SHAPE
 * ops/github-runner/wrangler.github-runner.jsonc actually runs (`standard-2`: 1 vCPU / 6 GiB / 12 GB
 * disk), not the smaller "lite" shape a prior figure may have been computed against.
 *
 * Prints a result anyone can re-run before the next launch; writes nothing, mutates nothing.
 *
 * Usage: npx tsx scripts/remeasure-own-ci-cost.ts [--repo owner/name] [--count N]
 */
import { execFileSync } from "node:child_process";
import { createCloudflareContainersStandard2CostModel } from "../src/usage/cost-model.js";

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith("--")) args[arg.slice(2)] = argv[++i] ?? "";
  }
  return args;
}

function ghApi(path: string): unknown {
  const out = execFileSync("gh", ["api", path], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(out);
}

interface WorkflowRun {
  id: number;
  conclusion: string | null;
}
interface Job {
  id: number;
  name: string;
  started_at: string;
  completed_at: string;
  conclusion: string | null;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const repo = args.repo ?? "DiffCI/DiffCI.com";
  const count = Number.parseInt(args.count ?? "10", 10);

  const runsResp = ghApi(`repos/${repo}/actions/workflows/ci.yml/runs?per_page=${count}&status=completed&branch=main`) as { workflow_runs: WorkflowRun[] };
  const runs = runsResp.workflow_runs.filter((r) => r.conclusion === "success");
  if (runs.length === 0) {
    console.error("no successful completed runs found - nothing to measure");
    process.exit(1);
  }

  const durationsSec: number[] = [];
  for (const run of runs) {
    const jobsResp = ghApi(`repos/${repo}/actions/runs/${run.id}/jobs`) as { jobs: Job[] };
    for (const job of jobsResp.jobs) {
      if (job.conclusion !== "success" || !job.started_at || !job.completed_at) continue;
      const ms = new Date(job.completed_at).getTime() - new Date(job.started_at).getTime();
      if (Number.isFinite(ms) && ms > 0) durationsSec.push(ms / 1000);
    }
  }

  if (durationsSec.length === 0) {
    console.error("no job-level timings could be read - nothing to measure");
    process.exit(1);
  }

  const sorted = [...durationsSec].sort((a, b) => a - b);
  const min = sorted[0]!;
  const max = sorted[sorted.length - 1]!;
  const mean = durationsSec.reduce((a, b) => a + b, 0) / durationsSec.length;
  const median = sorted[Math.floor(sorted.length / 2)]!;

  const model = createCloudflareContainersStandard2CostModel();
  const costAt = (seconds: number) => model.estimateCost({ computeSeconds: seconds }).estimatedUsd;

  console.log(`\nDiffCI own-CI re-measurement — ${repo}, last ${durationsSec.length} successful "check" job(s), ${new Date().toISOString().slice(0, 10)}\n`);
  console.log(`  job durations (s): ${durationsSec.map((d) => d.toFixed(0)).join(", ")}`);
  console.log(`  min    ${min.toFixed(1)}s`);
  console.log(`  median ${median.toFixed(1)}s`);
  console.log(`  mean   ${mean.toFixed(1)}s`);
  console.log(`  max    ${max.toFixed(1)}s`);
  console.log(`\n  Cloudflare Containers ${model.name} rate: $${model.estimateCost({ computeSeconds: 1 }).ratePerComputeSecondUsd.toFixed(8)}/compute-second`);
  console.log(`  cost at median duration  $${costAt(median).toFixed(6)}`);
  console.log(`  cost at mean duration    $${costAt(mean).toFixed(6)}`);
  console.log(`  cost range (min..max)    $${costAt(min).toFixed(6)} .. $${costAt(max).toFixed(6)}`);
  console.log(`\n  basis: provider_estimate (real published Cloudflare rate x measured job duration) - not an invoice line.\n`);
}

main();
