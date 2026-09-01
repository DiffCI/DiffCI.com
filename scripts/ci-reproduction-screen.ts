/**
 * CI_REPRODUCTION_05 screening — R1, R2 and R4, in frozen rank order.
 *
 * Applies the criteria frozen in `docs/ci-reproduction-05-eligibility.md` BEFORE any candidate was
 * evaluated. This script does not choose anything: the frame ordering is external, the criteria are
 * fixed, and it walks the ranks and records what it finds.
 *
 * R3 (the reference arm actually completing in the canonical container) is deliberately NOT here. It
 * costs up to 90 minutes per candidate and runs separately, in the order this script emits.
 *
 * The engine is never invoked. Screening must not select for repositories the inference engine happens
 * to handle, or the eventual reproduction result becomes a tautology.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

/** The six frozen RED repositories the inference engine was BUILT against — see R4. */
const INFERENCE_BENCHMARK = new Set([
  "ant-design/ant-design",
  "jantimon/html-webpack-plugin",
  "lint-staged/lint-staged",
  "testing-library/jest-dom",
  "vuejs/eslint-plugin-vue",
  "vuejs/vue-loader",
]);

/** The container's node major. R2 requires CI to have run this major on ubuntu. */
const CONTAINER_NODE_MAJOR = 22;

const USABLE = new Set(["success", "failure"]);

function gh(path: string): any {
  const out = execFileSync("gh", ["api", path], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(out);
}

function ghSafe(path: string): any {
  try {
    return gh(path);
  } catch {
    return undefined;
  }
}

function frame(): string[] {
  const names: string[] = [];
  for (const f of ["frame-ranks-1-40.json", "frame-ranks-41-140.json", "frame-ranks-141-240.json"]) {
    const doc = JSON.parse(readFileSync(`docs/evidence/survey/${f}`, "utf8")) as { ranks: string[] };
    names.push(...doc.ranks);
  }
  return names;
}

/** npm package -> owner/repo, from the registry's own metadata. No guessing from the package name. */
function repoOf(pkg: string): string | undefined {
  const meta = ghSafe(`https://registry.npmjs.org/${encodeURIComponent(pkg).replace("%40", "@")}`);
  const url: string | undefined = meta?.repository?.url ?? meta?.repository;
  if (typeof url !== "string") return undefined;
  const m = /github\.com[/:]([^/]+)\/([^/.#]+)/.exec(url);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/**
 * Does this job name name the container's node major?
 *
 * GitHub names matrix jobs `job (22.x, ubuntu-latest)`, so the matrix value is usually right there. An
 * UNDETERMINED node version is NOT a pass — unknown is not eligibility.
 */
function namesNodeMajor(name: string): boolean {
  return new RegExp(`(^|[^0-9.])${CONTAINER_NODE_MAJOR}(\\.[0-9x]+)?([^0-9.]|$)`).test(name);
}

function isUbuntu(labels: unknown): boolean {
  return Array.isArray(labels) && labels.some((l) => typeof l === "string" && /^ubuntu/i.test(l));
}

const TESTISH = /test|jest|vitest|mocha|spec|unit|ci/i;

interface Screened {
  rank: number;
  pkg: string;
  repo?: string;
  verdict: "QUALIFIED" | "R4_EXCLUDED" | "DEDUPED" | "NO_REPO" | "R1_NO_ACTIONS" | "R2_NO_GROUND_TRUTH" | "ERROR";
  detail: string;
  pinnedHeadSha?: string;
  groundTruth?: { cell: string; conclusion: string; source: string };
}

function screen(pkg: string, rank: number, seen: Set<string>): Screened | undefined {
  const repo = repoOf(pkg);
  if (!repo) return { rank, pkg, verdict: "NO_REPO", detail: "npm registry records no GitHub repository" };
  // Recorded, not skipped. Several packages map to one repository (react/react-dom -> facebook/react),
  // and a silently absent rank is indistinguishable from one that was never screened. A hole in the
  // record is the failure mode this laboratory keeps finding; leaving one here would be careless.
  if (seen.has(repo)) return { rank, pkg, repo, verdict: "DEDUPED", detail: "same repository as an earlier, higher-ranked package" };
  seen.add(repo);

  if (INFERENCE_BENCHMARK.has(repo)) {
    return { rank, pkg, repo, verdict: "R4_EXCLUDED", detail: "one of the six frozen RED inference-benchmark repositories" };
  }

  // R1 — completed Actions runs on the default branch.
  const info = ghSafe(`/repos/${repo}`);
  const branch = info?.default_branch;
  if (!branch) return { rank, pkg, repo, verdict: "ERROR", detail: "repository metadata unavailable" };

  const runs = ghSafe(`/repos/${repo}/actions/runs?branch=${branch}&status=completed&per_page=20`);
  if (!runs?.workflow_runs?.length) {
    return { rank, pkg, repo, verdict: "R1_NO_ACTIONS", detail: "no completed GitHub Actions runs on the default branch" };
  }

  // R2 — newest completed commit carrying an in-environment cell that concluded success|failure.
  for (const run of runs.workflow_runs) {
    const jobs = ghSafe(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`);
    for (const job of jobs?.jobs ?? []) {
      if (!USABLE.has(job.conclusion)) continue;
      if (!isUbuntu(job.labels)) continue;
      if (!namesNodeMajor(job.name)) continue;
      if (!TESTISH.test(job.name)) continue;
      return {
        rank,
        pkg,
        repo,
        verdict: "QUALIFIED",
        detail: `in-environment cell concluded ${job.conclusion}`,
        pinnedHeadSha: run.head_sha,
        groundTruth: { cell: job.name, conclusion: job.conclusion, source: `github actions job ${job.id}` },
      };
    }
  }
  return { rank, pkg, repo, verdict: "R2_NO_GROUND_TRUTH", detail: `no ubuntu + node ${CONTAINER_NODE_MAJOR} test cell concluded success/failure in the last 20 completed runs` };
}

function main(): void {
  const want = Number(process.argv[2] ?? 5);
  const limit = Number(process.argv[3] ?? 240);
  const names = frame().slice(0, limit);
  const seen = new Set<string>();
  const rows: Screened[] = [];
  const qualified: Screened[] = [];

  for (const [i, pkg] of names.entries()) {
    const row = screen(pkg, i + 1, seen);
    if (!row) continue;
    rows.push(row);
    const mark = row.verdict === "QUALIFIED" ? "QUALIFIED" : row.verdict;
    console.log(`  rank ${String(row.rank).padStart(3)}  ${mark.padEnd(19)} ${(row.repo ?? row.pkg).padEnd(45)} ${row.detail.slice(0, 60)}`);
    if (row.verdict === "QUALIFIED") {
      qualified.push(row);
      if (qualified.length >= want) break;
    }
  }

  writeFileSync(
    "docs/evidence/ci-reproduction-05-screening.json",
    `${JSON.stringify(
      {
        protocol: "docs/ci-reproduction-05-eligibility.md",
        frame: "npm-high-impact@1.13.0 topDependent, ranks 1-240, frozen",
        containerNodeMajor: CONTAINER_NODE_MAJOR,
        note: "R3 is NOT evaluated here. The inference engine was not invoked. Rejected candidates are retained as evidence.",
        screened: rows.length,
        qualified: qualified.map((q) => ({ rank: q.rank, repo: q.repo, pinnedHeadSha: q.pinnedHeadSha, groundTruth: q.groundTruth })),
        rows,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\n${qualified.length} qualified on R1/R2/R4, in rank order. R3 runs next, in this order.`);
}

main();
