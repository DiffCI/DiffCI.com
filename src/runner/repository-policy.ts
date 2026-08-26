/**
 * R2 repository acquisition policy (Parts 10-13). Hard-limits real repository execution to a
 * server-side allowlist - a caller cannot substitute a different owner/repo into a request no matter
 * what the client sends, because nothing client-supplied is ever used to select which repository gets
 * cloned; only a value already present in this allowlist can be looked up at all.
 */
export interface RepositoryAllowlistEntry {
  ownerName: string; // "owner/name"
  cloneUrl: string; // public, credential-free HTTPS clone URL
}

// R2's ONE permitted real repository. NOT DiffCI.com itself - confirmed live (2026-08-22, via
// `gh repo view`) that DiffCI.com is actually PRIVATE, contradicting this spec's own original
// assumption ("public DiffCI.com repository, or another credential-free repository path if DiffCI.com
// is public"). Per that same conditional and an explicit decision with the user, R2 uses a real,
// genuinely public, independently-verified repository instead: deepseek-ai/deepseek-harness (a real,
// authentic, popular open-source project - verified live: legitimate multi-year org history, MIT
// license, no signs of being a spoofed/lookalike account).
export const R2_REPOSITORY_ALLOWLIST: readonly RepositoryAllowlistEntry[] = [{ ownerName: "deepseek-ai/deepseek-harness", cloneUrl: "https://github.com/deepseek-ai/deepseek-harness.git" }];

export function getAllowedRepository(ownerName: string): RepositoryAllowlistEntry | undefined {
  return R2_REPOSITORY_ALLOWLIST.find((e) => e.ownerName === ownerName);
}

/** Full 40-hex-character commit SHA only - never a mutable ref, branch name, or abbreviated SHA
 * (Part 10: "Do NOT execute mutable branch head without resolving SHA"). */
export function isValidFullCommitSha(sha: string): boolean {
  return /^[0-9a-f]{40}$/.test(sha);
}

export interface CommitVerificationResult {
  ok: boolean;
  reason?: "repository_not_allowed" | "invalid_sha_format" | "commit_not_found" | "sha_mismatch";
}

/**
 * Verifies a requested (repository, commit) pair BEFORE any clone/checkout happens - real evidence
 * from the provider (GitHub's own API), not merely "the string looks like a SHA." Public repositories
 * need no credential for this (Part 11) - an unauthenticated GET against a public repo's commit works
 * exactly as well as an authenticated one, just at a lower rate limit, which is fine for one
 * pre-registered, human-triggered R2 experiment.
 */
export async function verifyCommitBelongsToAllowedRepository(ownerName: string, sha: string, fetchFn: typeof fetch = fetch): Promise<CommitVerificationResult> {
  const entry = getAllowedRepository(ownerName);
  if (!entry) return { ok: false, reason: "repository_not_allowed" };
  if (!isValidFullCommitSha(sha)) return { ok: false, reason: "invalid_sha_format" };

  const res = await fetchFn(`https://api.github.com/repos/${ownerName}/commits/${sha}`, { headers: { Accept: "application/vnd.github+json", "User-Agent": "diffci-r2-verification" } });
  if (res.status === 404) return { ok: false, reason: "commit_not_found" };
  if (!res.ok) return { ok: false, reason: "commit_not_found" }; // any non-2xx is treated as "could not confirm this commit exists" - never assumed valid on ambiguous evidence
  const body = (await res.json()) as { sha?: string };
  if (body.sha !== sha) return { ok: false, reason: "sha_mismatch" }; // GitHub can resolve short SHAs - reject anything that doesn't echo back the EXACT full SHA requested
  return { ok: true };
}
