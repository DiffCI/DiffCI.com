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
 * UPDATED 2026-08-26 (Phase 01 F3). Those vitest/vite verdicts were faithful to the collector and
 * WRONG about the engine: the graph builder had already supported per-package tsconfigs since
 * 2026-08-24, and both repositories build real graphs (2118 and 1131 nodes) once the gate lets them
 * through. The screen now mirrors the widened rule - a root tsconfig.json OR per-package tsconfigs
 * anywhere in the tree - and reports the nested case as eligible-with-a-caveat rather than refusing
 * it, because merged compiler options cap graph confidence at PARTIAL. The cost control this script
 * was written for is unchanged; only the boundary moved, to where it always should have been.
 *
 * This is a SCREEN, not a guarantee. It mirrors the condition the collector checks first
 * (src/research/repository/collector.ts, which now delegates to classifyTypeScriptProject()). A
 * repository can still turn out to be unanalysable for other reasons, which is why the in-pipeline
 * refusal (auto-pause after repeated poll failures) exists as the backstop rather than being
 * replaced by this. A repository tree too large to enumerate in one API call is reported UNDETERMINED
 * rather than INELIGIBLE - an unanswerable question is not a negative answer.
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
  /** Which TypeScript project layout was found - "nested" repositories are analysable but their
   * merged compiler options cap graph confidence at PARTIAL. */
  tsconfigKind?: "root" | "nested" | "none";
  nestedTsconfigCount?: number;
}

export async function screenRepository(repository: string, token?: string): Promise<EligibilityVerdict> {
  const meta = (await (await fetch(`https://api.github.com/repos/${repository}`, { headers: H(token) })).json()) as {
    default_branch?: string;
    archived?: boolean;
    message?: string;
  };
  if (meta.message) return { repository, eligible: false, reason: `repository unreachable: ${meta.message}` };
  if (meta.archived) return { repository, eligible: false, reason: "repository is archived - it will never produce new commits" };

  // The condition the collector checks first. Phase 01 (2026-08-26) widened it on both sides to
  // match what the graph builder can actually do: a root tsconfig.json OR per-package tsconfigs
  // anywhere in the tree. Refusing the second class is what excluded vitest-dev/vitest and
  // facebook/docusaurus, both of which build real graphs (2118 and 1131 nodes) once the gate lets
  // them through - the refusal was a stale gate, not an engine limit.
  const rootTsconfig = await fetch(`https://api.github.com/repos/${repository}/contents/tsconfig.json`, { headers: H(token), redirect: "follow" });
  let tsconfigKind: "root" | "nested" | "none" = rootTsconfig.status === 200 ? "root" : "none";
  let nestedTsconfigCount = 0;

  if (tsconfigKind === "none") {
    // One tree read answers the nested case for the whole repository. `truncated` means the tree is
    // too large for a single response, in which case the absence of a match proves nothing and the
    // screen says so rather than reporting a false INELIGIBLE.
    const tree = (await (
      await fetch(`https://api.github.com/repos/${repository}/git/trees/${meta.default_branch}?recursive=1`, { headers: H(token) })
    ).json()) as { tree?: Array<{ path?: string; type?: string }>; truncated?: boolean };

    const nested = (tree.tree ?? []).filter(
      (entry) =>
        entry.type === "blob" &&
        entry.path?.endsWith("tsconfig.json") &&
        !entry.path.startsWith("node_modules/") &&
        !entry.path.includes("/node_modules/"),
    );
    nestedTsconfigCount = nested.length;
    if (nested.length > 0) tsconfigKind = "nested";

    if (tsconfigKind === "none") {
      return {
        repository,
        eligible: false,
        reason: tree.truncated
          ? "UNDETERMINED - no root tsconfig.json and the repository tree is too large to enumerate in one request; screen it by cloning rather than trusting this result"
          : "STRUCTURALLY_INELIGIBLE_NO_TYPESCRIPT_PROJECT - no tsconfig.json anywhere in the repository, so there is nothing for the graph builder to parse",
        defaultBranch: meta.default_branch,
      };
    }
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

  const layoutNote =
    tsconfigKind === "nested"
      ? ` (monorepo layout: ${nestedTsconfigCount} per-package tsconfig.json, no root one - graph confidence is capped at PARTIAL, so expect a higher FULL-fallback rate)`
      : "";

  return {
    repository,
    eligible: true,
    reason:
      (commitsLast14d === 0
        ? "eligible, but DORMANT - no default-branch commits in 14 days, so it will produce no evidence"
        : "eligible") + layoutNote,
    defaultBranch: meta.default_branch,
    commitsLast14d,
    hasActions,
    tsconfigKind,
    nestedTsconfigCount,
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
