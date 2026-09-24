/**
 * Write-side GitHub client for the separate DiffCI Adoption App.
 *
 * This must not be wired to the read-only observer App. Callers prepare the package.json, lockfile,
 * and workflow bytes elsewhere (normally by running `diffci init --install --workflow` in an isolated
 * checkout); this module only publishes those reviewed bytes as one atomic commit and opens a PR.
 */

const GITHUB_API = "https://api.github.com";
const HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2026-03-10",
  "User-Agent": "DiffCI-Adoption-App",
};

export interface AdoptionChange {
  path: string;
  content: string;
}

export interface CreateAdoptionPullRequestInput {
  installationToken: string;
  repository: string;
  baseBranch: string;
  branch: string;
  title: string;
  body: string;
  commitMessage: string;
  changes: AdoptionChange[];
}

export interface AdoptionPullRequestResult {
  number: number;
  url: string;
  branch: string;
  commitSha: string;
}

export interface WorkflowOnlyAdoptionInput {
  installationToken: string;
  repository: string;
  baseBranch: string;
  branch: string;
  diffciVersion: string;
}

interface GithubError { message?: string }

function assertSafeInput(input: CreateAdoptionPullRequestInput): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository)) throw new Error("repository must be owner/name");
  for (const branch of [input.baseBranch, input.branch]) {
    if (!branch || branch.startsWith("-") || branch.includes("..") || /[\s~^:?*]/.test(branch) || branch.includes("[") || branch.includes("]") || branch.includes("\\")) {
      throw new Error(`unsafe branch name ${JSON.stringify(branch)}`);
    }
  }
  if (input.changes.length === 0) throw new Error("at least one adoption change is required");
  const paths = new Set<string>();
  for (const change of input.changes) {
    if (!change.path || change.path.startsWith("/") || change.path.includes("\\") || change.path.split("/").includes("..")) {
      throw new Error(`unsafe repository path ${JSON.stringify(change.path)}`);
    }
    if (paths.has(change.path)) throw new Error(`duplicate repository path ${change.path}`);
    paths.add(change.path);
  }
}

async function githubJson<T>(
  fetchFn: typeof fetch,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetchFn(`${GITHUB_API}${path}`, {
    ...init,
    headers: { ...HEADERS, Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as GithubError;
    throw new Error(`GitHub ${init.method ?? "GET"} ${path} failed (${response.status}): ${error.message ?? "unknown error"}`);
  }
  return (await response.json()) as T;
}

async function githubPathExists(fetchFn: typeof fetch, token: string, repository: string, path: string, ref: string): Promise<boolean> {
  const response = await fetchFn(`${GITHUB_API}/repos/${repository}/contents/${path}?ref=${encodeURIComponent(ref)}`, {
    headers: { ...HEADERS, Authorization: `Bearer ${token}` },
  });
  if (response.status === 404) return false;
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as GithubError;
    throw new Error(`GitHub GET contents/${path} failed (${response.status}): ${error.message ?? "unknown error"}`);
  }
  return true;
}

export function workflowOnlyChange(version: string): AdoptionChange {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`invalid DiffCI version ${JSON.stringify(version)}`);
  return {
    path: ".github/workflows/diffci.yml",
    content: `name: DiffCI observation
on: [push, pull_request]
permissions:
  contents: read
jobs:
  diffci:
    runs-on: ubuntu-latest
    continue-on-error: true
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx @diffci.com/diffci@${version} observe --no-send
`,
  };
}

/** Default, zero-DiffCI-compute adoption path. GitHub runs the pinned npx observer after merge. */
export async function createWorkflowOnlyAdoptionPullRequest(
  input: WorkflowOnlyAdoptionInput,
  fetchFn: typeof fetch = fetch,
): Promise<AdoptionPullRequestResult> {
  const change = workflowOnlyChange(input.diffciVersion);
  assertSafeInput({ ...input, title: "Add DiffCI observation", body: "", commitMessage: "ci: add DiffCI observation", changes: [change] });
  if (await githubPathExists(fetchFn, input.installationToken, input.repository, change.path, input.baseBranch)) {
    throw new Error(`${change.path} already exists; refusing to overwrite an existing workflow`);
  }
  return createAdoptionPullRequest({
    installationToken: input.installationToken,
    repository: input.repository,
    baseBranch: input.baseBranch,
    branch: input.branch,
    title: "Add DiffCI observation",
    commitMessage: "ci: add DiffCI observation",
    body: "Adds a pinned, separate, non-blocking DiffCI observation workflow. It does not change existing required CI, package.json, or a lockfile. This pull request was opened as a draft for maintainer review.",
    changes: [change],
  }, fetchFn);
}

export async function createAdoptionPullRequest(
  input: CreateAdoptionPullRequestInput,
  fetchFn: typeof fetch = fetch,
): Promise<AdoptionPullRequestResult> {
  assertSafeInput(input);
  const repoPath = `/repos/${input.repository}`;
  const ref = await githubJson<{ object: { sha: string } }>(fetchFn, input.installationToken, `${repoPath}/git/ref/heads/${encodeURIComponent(input.baseBranch)}`);
  const baseCommit = await githubJson<{ tree: { sha: string } }>(fetchFn, input.installationToken, `${repoPath}/git/commits/${ref.object.sha}`);

  const blobs = await Promise.all(input.changes.map(async (change) => ({
    path: change.path,
    sha: (await githubJson<{ sha: string }>(fetchFn, input.installationToken, `${repoPath}/git/blobs`, {
      method: "POST",
      body: JSON.stringify({ content: change.content, encoding: "utf-8" }),
    })).sha,
  })));
  const tree = await githubJson<{ sha: string }>(fetchFn, input.installationToken, `${repoPath}/git/trees`, {
    method: "POST",
    body: JSON.stringify({
      base_tree: baseCommit.tree.sha,
      tree: blobs.map((blob) => ({ path: blob.path, mode: "100644", type: "blob", sha: blob.sha })),
    }),
  });
  const commit = await githubJson<{ sha: string }>(fetchFn, input.installationToken, `${repoPath}/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message: input.commitMessage, tree: tree.sha, parents: [ref.object.sha] }),
  });
  await githubJson(fetchFn, input.installationToken, `${repoPath}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${input.branch}`, sha: commit.sha }),
  });
  const pull = await githubJson<{ number: number; html_url: string }>(fetchFn, input.installationToken, `${repoPath}/pulls`, {
    method: "POST",
    body: JSON.stringify({ title: input.title, body: input.body, head: input.branch, base: input.baseBranch, draft: true }),
  });
  return { number: pull.number, url: pull.html_url, branch: input.branch, commitSha: commit.sha };
}
