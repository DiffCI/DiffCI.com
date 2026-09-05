/**
 * Report access for a signed-in GitHub user (2026-09-05, seamless install, private repositories).
 *
 * A private repository's report is not public by URL: it needs the repository's report token. This module
 * decides which enrolled repositories a GitHub user may see, using GitHub's own answer - "is this login a
 * collaborator on that repository?" - asked with the Shadow App's installation token. Nothing is inferred
 * from the login text, and an unanswered question (permission missing, GitHub unreachable) is reported as
 * unknown, never as access.
 *
 * Read-only: it never generates tokens or changes repository rows. A private repository whose token has
 * not been generated yet (identification records privacy and mints the token) is listed without a link.
 */

export interface ReportAccessCandidate {
  repository: string;
  state: string;
  isPrivate: boolean;
  reportToken?: string;
}

export interface ReportAccessEntry {
  repository: string;
  state: string;
  isPrivate: boolean;
  /** Present for private repositories whose token exists; public repositories need none. */
  reportToken?: string;
}

export interface ReportAccessResult {
  login: string;
  repositories: ReportAccessEntry[];
  /** Enrolled repositories GitHub could not answer for - shown to the user as "could not check", never hidden. */
  unknown: string[];
  checked: number;
}

export type CollaboratorAnswer = "yes" | "no" | "unknown";

export interface ReportAccessDeps {
  store: { listReportAccessCandidates(limit: number): Promise<ReportAccessCandidate[]> };
  isCollaborator(repository: string, login: string): Promise<CollaboratorAnswer>;
  /** Upper bound on repositories checked per call; each check is one GitHub API call. */
  maxRepositories?: number;
  log?: (message: string) => void;
}

const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export function isValidGitHubLogin(login: string): boolean {
  return LOGIN_PATTERN.test(login);
}

export async function listReportAccessForLogin(deps: ReportAccessDeps, login: string): Promise<ReportAccessResult> {
  if (!isValidGitHubLogin(login)) throw new Error("login is not a valid GitHub username");
  const log = deps.log ?? (() => {});
  const candidates = await deps.store.listReportAccessCandidates(deps.maxRepositories ?? 200);
  const repositories: ReportAccessEntry[] = [];
  const unknown: string[] = [];
  // Small batches: a dashboard load should not fan out one request per enrolled repository at once.
  const batch = 5;
  for (let i = 0; i < candidates.length; i += batch) {
    const slice = candidates.slice(i, i + batch);
    const answers = await Promise.all(slice.map((c) => deps.isCollaborator(c.repository, login).catch(() => "unknown" as const)));
    slice.forEach((c, j) => {
      const answer = answers[j];
      if (answer === "yes") repositories.push({ repository: c.repository, state: c.state, isPrivate: c.isPrivate, reportToken: c.isPrivate ? c.reportToken : undefined });
      else if (answer === "unknown") unknown.push(c.repository);
    });
  }
  log(`shadow-report-access: ${login}: ${repositories.length} accessible of ${candidates.length} checked, ${unknown.length} unknown`);
  return { login, repositories, unknown, checked: candidates.length };
}

/**
 * GitHub's answer via the repository's installation token. 204 = collaborator (for organization
 * repositories this includes members with access through teams), 404 = not a collaborator. Anything else
 * - no token, 401/403 (the App lacks the permission), 5xx - is unknown.
 */
export function makeGitHubCollaboratorCheck(
  tokenFor: (repository: string) => Promise<string | undefined>,
  fetchImpl: typeof fetch = fetch,
): (repository: string, login: string) => Promise<CollaboratorAnswer> {
  return async (repository, login) => {
    const token = await tokenFor(repository);
    if (!token) return "unknown";
    const [owner, name] = repository.split("/");
    if (!owner || !name) return "unknown";
    const res = await fetchImpl(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/collaborators/${encodeURIComponent(login)}`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "diffci-shadow", "X-GitHub-Api-Version": "2026-03-10" },
    });
    if (res.status === 204) return "yes";
    if (res.status === 404) return "no";
    return "unknown";
  };
}
