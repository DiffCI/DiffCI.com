/**
 * Pre-enrollment eligibility screen (2026-08-26).
 *
 * Answers, for a few cents of GitHub API, the question that previously cost a container launch every ten
 * minutes to answer: can DiffCI's collector actually analyse this repository?
 *
 * WHY THIS EXISTS. vitest-dev/vitest was enrolled, and every sweep launched a standard-2 container, cloned
 * the repository, and only THEN discovered there is no tsconfig.json at the root (it is a monorepo with
 * per-package tsconfigs). The exclusion is raised inside the container, so the full cost was incurred each
 * time. Screening before enrollment turns that into one cheap HTTP request.
 *
 * Validated against ground truth on the day it was written: it correctly predicted the in-container
 * outcome for both known cases - unjs/nitro ELIGIBLE (polls successfully) and vitest-dev/vitest
 * INELIGIBLE (clone-excluded) - and caught vitejs/vite as INELIGIBLE before it was ever enrolled.
 *
 * This is a SCREEN, not a guarantee. It mirrors the one condition the collector checks first
 * (src/research/repository/collector.ts: a root tsconfig.json). A repository can still turn out to be
 * unanalysable for other reasons, which is why the in-pipeline refusal (auto-pause after repeated poll
 * failures) exists as the backstop rather than being replaced by this.
 *
 * Deliberately NOT an engine change. Monorepo support is a real gap and remains open; this bounds its
 * COST without pretending to close it.
 *
 * Usage: npx tsx scripts/screen-shadow-eligibility.ts owner/repo [owner/repo ...]
 *   GITHUB_TOKEN optional but recommended (60 req/hour unauthenticated).
 */
const H = (token?: string): Record<string, string> => {
  const h: Record<string, string> = { "User-Agent": "diffci-shadow", Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10" };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
};

export interface EligibilityVerdict {
  repository: string;
  eligible: boolean;
  reason: string;
  defaultBranch?: string;
  commitsLast14d?: number;
  hasActions?: boolean;
}

export async function screenRepository(repository: string, token?: string): Promise<EligibilityVerdict> {
  const meta = (await (await fetch(`https://api.github.com/repos/${repository}`, { headers: H(token) })).json()) as {
    default_branch?: string;
    archived?: boolean;
    message?: string;
  };
  if (meta.message) return { repository, eligible: false, reason: `repository unreachable: ${meta.message}` };
  if (meta.archived) return { repository, eligible: false, reason: "repository is archived - it will never produce new commits" };

  // The exact condition the collector checks first, and the one that excluded vitest.
  const tsconfig = await fetch(`https://api.github.com/repos/${repository}/contents/tsconfig.json`, { headers: H(token), redirect: "follow" });
  if (tsconfig.status !== 200) {
    return {
      repository,
      eligible: false,
      reason: `STRUCTURALLY_INELIGIBLE_ROOT_TSCONFIG_REQUIRED - no tsconfig.json at the repository root (HTTP ${tsconfig.status}). Typically a monorepo with per-package tsconfigs.`,
      defaultBranch: meta.default_branch,
    };
  }

  // Not eligibility, but decision-relevant: a repository with no Actions produces no workload telemetry,
  // and a dormant one produces no evidence however eligible it is.
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const commits = (await (await fetch(`https://api.github.com/repos/${repository}/commits?sha=${meta.default_branch}&since=${since}&per_page=100`, { headers: H(token) })).json()) as unknown[];
  const runs = (await (await fetch(`https://api.github.com/repos/${repository}/actions/runs?per_page=1`, { headers: H(token) })).json()) as { total_count?: number };

  const commitsLast14d = Array.isArray(commits) ? commits.length : 0;
  const hasActions = (runs.total_count ?? 0) > 0;
  if (!hasActions) {
    return { repository, eligible: false, reason: "no GitHub Actions runs - there is no CI workload to observe", defaultBranch: meta.default_branch, commitsLast14d, hasActions };
  }

  return {
    repository,
    eligible: true,
    reason: commitsLast14d === 0 ? "eligible, but DORMANT - no default-branch commits in 14 days, so it will produce no evidence" : "eligible",
    defaultBranch: meta.default_branch,
    commitsLast14d,
    hasActions,
  };
}

async function main() {
  const repos = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (repos.length === 0) throw new Error("usage: screen-shadow-eligibility.ts owner/repo [owner/repo ...]");
  const token = process.env.GITHUB_TOKEN;
  if (!token) console.log("(unauthenticated - 60 req/hour)\n");

  for (const repository of repos) {
    const v = await screenRepository(repository, token);
    const mark = v.eligible ? "ELIGIBLE  " : "INELIGIBLE";
    const activity = typeof v.commitsLast14d === "number" ? `  ${v.commitsLast14d} commits/14d` : "";
    console.log(`${mark} ${v.repository.padEnd(22)}${activity}`);
    console.log(`           ${v.reason}`);
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop() ?? "")) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
