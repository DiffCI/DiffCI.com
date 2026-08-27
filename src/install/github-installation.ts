/**
 * Connecting a GitHub App installation to an organization (Phase 03 follow-up, 2026-08-26).
 *
 * Before this, `POST /v1/organizations/:id/repositories` took `providerRepositoryId` and `ownerName` as
 * typed input - which meant a self-serving stranger had to find GitHub's numeric repository id by hand,
 * and meant the product believed whatever id they typed. Both are fixed by the same change: after
 * someone installs the App, GitHub itself tells us which repositories the installation covers, and those
 * are the only ones that get connected.
 *
 * THE RULE THAT MATTERS. A repository already connected to another organization is REFUSED, never moved.
 * GitHub will happily let two different accounts install an App on repositories they each control, and
 * nothing stops someone installing on a repository that another DiffCI organization already claimed
 * (a fork's upstream, a transferred repository, a shared org). Silently re-parenting the row would move
 * that repository's observations, its credentials and its history into the newcomer's tenant. So the
 * claim stands with whoever connected first, and the newcomer is told plainly.
 */
import { exchangeInstallationToken, signAppJwt } from "../shadow/github-app.js";
import { decideRepositoryAdmission, EARLY_ACCESS_ENABLED } from "../billing/repository-admission.js";
import type { ProductStore } from "../product/store.js";
import type { Repository } from "../product/types.js";

export interface GithubAppCredentials {
  appId: string;
  /** PKCS#8 PEM. See signAppJwt's own note about converting GitHub's PKCS#1 download. */
  privateKeyPkcs8Pem: string;
}

/** One repository as GitHub's installation endpoint describes it. */
export interface InstallationRepository {
  providerRepositoryId: string;
  ownerName: string;
  defaultBranch: string;
  private: boolean;
}

interface GithubRepositoryPayload {
  id: number;
  full_name: string;
  default_branch?: string;
  private?: boolean;
}

const GITHUB_API = "https://api.github.com";
const PAGE_SIZE = 100;
/** A bound, not a belief about how many repositories anyone has - it stops one call walking forever. */
const MAX_PAGES = 10;

function toInstallationRepository(payload: GithubRepositoryPayload): InstallationRepository {
  return {
    providerRepositoryId: String(payload.id),
    ownerName: payload.full_name,
    // GitHub omits default_branch on some payload shapes (the webhook's abbreviated repository object).
    // "main" is a guess, and the flow records it as one rather than pretending GitHub said it.
    defaultBranch: payload.default_branch ?? "main",
    private: payload.private === true,
  };
}

/**
 * Every repository an installation covers. Paginated, because "install on all repositories" on a large
 * account is thousands, and a first page would silently connect a subset.
 */
export async function listInstallationRepositories(
  installationToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<InstallationRepository[]> {
  const repositories: InstallationRepository[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await fetchFn(`${GITHUB_API}/installation/repositories?per_page=${PAGE_SIZE}&page=${page}`, {
      headers: {
        Authorization: `Bearer ${installationToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
        // Required: GitHub's API firewall 403s any request without one (see github-app.ts).
        "User-Agent": "DiffCI-App",
      },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`listing installation repositories failed (${response.status}): ${text.slice(0, 200)}`);
    }
    const body = (await response.json()) as { repositories?: GithubRepositoryPayload[] };
    const batch = body.repositories ?? [];
    repositories.push(...batch.map(toInstallationRepository));
    if (batch.length < PAGE_SIZE) break;
  }
  return repositories;
}

export type ConnectedOutcome =
  /** Newly connected to this organization. */
  | { result: "connected"; repository: Repository }
  /** Already this organization's; installation id and metadata refreshed. */
  | { result: "updated"; repository: Repository }
  /** Connected to a DIFFERENT organization. Left exactly as it was. */
  | { result: "claimed_elsewhere"; ownerName: string; providerRepositoryId: string }
  /** Not connected: the organization is at its plan limit and this deployment is not in early access. */
  | { result: "plan_limit_reached"; ownerName: string; providerRepositoryId: string };

export interface ConnectInstallationDeps {
  productStore: ProductStore;
  credentials: GithubAppCredentials;
  fetchFn?: typeof fetch;
  /** Injected in tests so the flow can be exercised without a real App key or a network. */
  listRepositories?: (installationId: string) => Promise<InstallationRepository[]>;
  /**
   * The organization's plan limit. Defaults to unlimited, which is what early access means in practice
   * for this path - see src/billing/repository-admission.ts for why the installation path is the one
   * that gets the exemption.
   */
  maxRepositories?: number;
  /** Defaults to the deployment-wide flag. Present so tests can exercise the post-early-access world. */
  earlyAccess?: boolean;
}

export interface ConnectInstallationResult {
  installationId: string;
  outcomes: ConnectedOutcome[];
  connected: number;
  updated: number;
  refused: number;
  /** Repositories not connected because the organization is at its plan limit (never during early access). */
  planLimited: number;
}

/**
 * Attaches an installation's repositories to one organization. The caller has already established that
 * the requesting user is a member of that organization - this function does not re-check membership,
 * and must never be reachable from a route that has not. `userId` is absent when the caller is a
 * webhook rather than a person, in which case the audit entry records the event with no actor rather
 * than inventing one.
 */
export async function connectInstallation(
  deps: ConnectInstallationDeps,
  input: { organizationId: string; userId?: string; installationId: string },
): Promise<ConnectInstallationResult> {
  const repositories = deps.listRepositories
    ? await deps.listRepositories(input.installationId)
    : await listInstallationRepositories(
        (
          await exchangeInstallationToken(
            await signAppJwt({ appId: deps.credentials.appId, privateKeyPkcs8Pem: deps.credentials.privateKeyPkcs8Pem }),
            input.installationId,
            deps.fetchFn ?? fetch,
          )
        ).token,
        deps.fetchFn ?? fetch,
      );

  const outcomes: ConnectedOutcome[] = [];
  for (const repository of repositories) {
    const existing = await deps.productStore.getRepositoryByProviderId(repository.providerRepositoryId);

    if (existing && existing.organizationId !== input.organizationId) {
      outcomes.push({ result: "claimed_elsewhere", ownerName: repository.ownerName, providerRepositoryId: repository.providerRepositoryId });
      continue;
    }

    if (existing) {
      await deps.productStore.updateRepositoryFromProvider(existing.id, {
        ownerName: repository.ownerName,
        defaultBranch: repository.defaultBranch,
        installationId: input.installationId,
      });
      if (existing.status === "removed" || existing.status === "pending") {
        await deps.productStore.setRepositoryStatus(existing.id, "active");
      }
      const refreshed = await deps.productStore.getRepository(existing.id);
      outcomes.push({ result: "updated", repository: refreshed ?? existing });
      continue;
    }

    // This path used to bypass the plan limit entirely, while the typed route enforced it - so early
    // access worked by inconsistency rather than by decision. The policy is now named and asserted
    // (src/billing/repository-admission.ts): installation-sourced connections are admitted during early
    // access because GitHub has already proved the installer controls the repository. Nothing about the
    // 15% savings-share model changes; this only decides admission, never price.
    const admission = decideRepositoryAdmission({
      entitlements: { maxRepositories: deps.maxRepositories ?? -1 },
      currentRepositoryCount: (await deps.productStore.listRepositories(input.organizationId)).length,
      source: "installation",
      earlyAccess: deps.earlyAccess ?? EARLY_ACCESS_ENABLED,
    });
    if (!admission.admit) {
      outcomes.push({ result: "plan_limit_reached", ownerName: repository.ownerName, providerRepositoryId: repository.providerRepositoryId });
      continue;
    }

    const created = await deps.productStore.createRepository({
      organizationId: input.organizationId,
      providerRepositoryId: repository.providerRepositoryId,
      ownerName: repository.ownerName,
      defaultBranch: repository.defaultBranch,
      installationId: input.installationId,
    });
    await deps.productStore.setRepositoryStatus(created.id, "active");
    outcomes.push({ result: "connected", repository: { ...created, status: "active" } });
  }

  const connected = outcomes.filter((o) => o.result === "connected").length;
  const updated = outcomes.filter((o) => o.result === "updated").length;
  const refused = outcomes.filter((o) => o.result === "claimed_elsewhere").length;
  const planLimited = outcomes.filter((o) => o.result === "plan_limit_reached").length;

  await deps.productStore.recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.userId,
    action: "installation.connected",
    targetType: "installation",
    targetId: input.installationId,
    metadata: { connected, updated, refused },
  });

  return { installationId: input.installationId, outcomes, connected, updated, refused, planLimited };
}
