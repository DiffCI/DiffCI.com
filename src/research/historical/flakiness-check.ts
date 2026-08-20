/**
 * Stage 1B fix (2026-08-21, docs/research/2026-08-21-stage1b-*.md): a lightweight cross-commit
 * flakiness signal for candidate historical "unsafe misses". Stage 1A's forensic investigation found 3
 * of 8 confirmed non-genuine misses were environment-dependent (a live-network test hitting a GitHub
 * API rate limit, a GitHub infrastructure outage, a flaky timing-threshold performance assertion) -
 * each confirmed via a manual check of whether the SAME job succeeded on nearby commits (it did, at a
 * high rate, in every case). This module automates exactly that check.
 *
 * Deliberately bounded and opt-in-per-candidate, not per-delta: this only runs for a job name that
 * ALREADY looks like a candidate unsafe miss (matched, test-category, SKIP_CANDIDATE), never for every
 * delta - historical evidence collection already has real GitHub REST rate-budget pressure (see
 * rate-budget.ts), and spending extra calls on deltas with no candidate miss at all would be waste.
 */
import { chargeBudget, hasBudgetFor, type RateBudget } from "./rate-budget.js";

const API_VERSION = "2026-03-10";

async function githubFetch(url: string, token?: string): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": API_VERSION };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status} ${url}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

export interface FlakinessCheckResult {
  /** False when the budget didn't allow checking, or the check itself failed - never fabricated as a
   * confident answer in that case. */
  checked: boolean;
  nearbyCommitsChecked: number;
  nearbySuccesses: number;
  /** True when nearbyCommitsChecked > 0 and the success rate meets FLAKY_SUCCESS_THRESHOLD - a
   * suspicion, not a certainty (this is a statistical signal over a small sample, not a proof the
   * specific historical failure was flaky - stated as "likely", never as confirmed). */
  likelyFlaky: boolean;
  reason?: string;
}

const DEFAULT_SAMPLE_SIZE = 5;
const FLAKY_SUCCESS_THRESHOLD = 0.7;
/** Budget reserved for one flakiness check: 1 call for the nearby-commit list, up to sampleSize calls
 * for their check-runs. */
function reserveFor(sampleSize: number): number {
  return 1 + sampleSize;
}

export async function checkJobFlakiness(options: {
  repository: string;
  jobName: string;
  aroundSha: string;
  token?: string;
  budget: RateBudget;
  sampleSize?: number;
}): Promise<FlakinessCheckResult> {
  const { repository, jobName, aroundSha, token, budget, sampleSize = DEFAULT_SAMPLE_SIZE } = options;
  const reserve = reserveFor(sampleSize);
  if (!hasBudgetFor(budget, reserve)) {
    return { checked: false, nearbyCommitsChecked: 0, nearbySuccesses: 0, likelyFlaky: false, reason: "github_rate_limit" };
  }

  let commits: unknown;
  try {
    commits = await githubFetch(`https://api.github.com/repos/${repository}/commits?sha=${aroundSha}&per_page=${sampleSize + 1}`, token);
    chargeBudget(budget, 1);
  } catch (error: unknown) {
    chargeBudget(budget, 1);
    return { checked: false, nearbyCommitsChecked: 0, nearbySuccesses: 0, likelyFlaky: false, reason: `fetch_error: ${error instanceof Error ? error.message : String(error)}` };
  }
  const shas = (Array.isArray(commits) ? commits : [])
    .map((c) => (c as Record<string, unknown>).sha)
    .filter((s): s is string => typeof s === "string" && s !== aroundSha)
    .slice(0, sampleSize);

  if (shas.length === 0) {
    return { checked: true, nearbyCommitsChecked: 0, nearbySuccesses: 0, likelyFlaky: false, reason: "no nearby commits found" };
  }

  const targetName = jobName.trim().toLowerCase();
  let checked = 0;
  let successes = 0;
  for (const sha of shas) {
    if (!hasBudgetFor(budget, 1)) break;
    try {
      const runs = await githubFetch(`https://api.github.com/repos/${repository}/commits/${sha}/check-runs`, token);
      chargeBudget(budget, 1);
      const checkRuns = Array.isArray((runs as Record<string, unknown>).check_runs) ? ((runs as Record<string, unknown>).check_runs as Record<string, unknown>[]) : [];
      const match = checkRuns.find((r) => typeof r.name === "string" && (r.name as string).trim().toLowerCase() === targetName);
      if (match) {
        checked++;
        if (match.conclusion === "success") successes++;
      }
    } catch {
      chargeBudget(budget, 1);
      // A single nearby-commit fetch failure doesn't invalidate the whole check - just contributes no
      // data point, same as a nearby commit that never ran this job at all.
    }
  }

  if (checked === 0) {
    return { checked: true, nearbyCommitsChecked: 0, nearbySuccesses: 0, likelyFlaky: false, reason: "job name not found on any nearby commit" };
  }

  const successRate = successes / checked;
  return { checked: true, nearbyCommitsChecked: checked, nearbySuccesses: successes, likelyFlaky: successRate >= FLAKY_SUCCESS_THRESHOLD };
}
