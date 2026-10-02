import { signAppJwt, exchangeInstallationToken } from "../shadow/github-app.js";
import { connectInstallation, type GithubAppCredentials } from "./github-installation.js";
import type { ProductStore } from "../product/store.js";
import type { OAuthStore } from "../auth/oauth-store.js";

/** Reconnect one explicitly named repository, without trusting an installation id supplied by a browser. */
export async function reconnectRepository(deps: {
  productStore: ProductStore; oauthStore: OAuthStore; credentials: GithubAppCredentials;
  fetchFn?: typeof fetch; appJwt?: () => Promise<string>;
}, input: { organizationId: string; userId: string; repository: string }) {
  const refuse = (error: string) => ({ ok: false as const, error });
  if (!await deps.productStore.isMember(input.organizationId, input.userId)) return refuse("unauthorized");
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(input.repository) || input.repository.length > 200)
    return refuse("Enter a repository as owner/name.");
  const login = await deps.oauthStore.getProviderLoginForUser(input.userId, "github");
  if (!login) return refuse("Sign in with GitHub before reconnecting.");
  const fetchFn = deps.fetchFn ?? fetch;
  const read = async (path: string, token: string) => {
    const response = await fetchFn(`https://api.github.com${path}`, {
      redirect: "manual", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
        "User-Agent": "DiffCI-App", "X-GitHub-Api-Version": "2026-03-10" },
    });
    if (!response.ok) throw new Error("github_unavailable");
    return response.json() as Promise<any>;
  };
  try {
    const jwt = await (deps.appJwt?.() ?? signAppJwt(deps.credentials));
    const path = `/repos/${input.repository.split("/").map(encodeURIComponent).join("/")}`;
    const installation = await read(`${path}/installation`, jwt);
    if (!Number.isSafeInteger(installation.id) || installation.id <= 0 || installation.suspended_at)
      return refuse("An active DiffCI installation could not be verified.");
    const installationId = String(installation.id);
    const { token } = await exchangeInstallationToken(jwt, installationId, fetchFn);
    const permission = await read(`${path}/collaborators/${encodeURIComponent(login)}/permission`, token);
    // Login names can be reassigned. Require the immutable GitHub identity to match the current session.
    if (permission.permission !== "admin" || !permission.user?.id ||
      await deps.oauthStore.getUserIdForProviderIdentity("github", String(permission.user.id)) !== input.userId)
      return refuse("GitHub repository administrator access is required. Sign in again if your GitHub username changed.");
    const repository = await read(path, token);
    if (!Number.isSafeInteger(repository.id) || repository.id <= 0 ||
      typeof repository.full_name !== "string" || repository.full_name.toLowerCase() !== input.repository.toLowerCase() ||
      typeof repository.default_branch !== "string") return refuse("Repository identity could not be verified.");
    const result = await connectInstallation({ ...deps, listRepositories: async () => [{
      providerRepositoryId: String(repository.id), ownerName: repository.full_name,
      defaultBranch: repository.default_branch, private: repository.private !== false,
    }] }, { ...input, installationId });
    if (result.refused) return refuse("This repository is already connected to another DiffCI organization.");
    if (result.planLimited) return refuse("This organization has reached its repository limit.");
    return { ok: true as const };
  } catch {
    return refuse("Could not verify GitHub access. Confirm the DiffCI App is installed for this repository, then retry.");
  }
}
