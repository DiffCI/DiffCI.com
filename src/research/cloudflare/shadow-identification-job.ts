/**
 * Automatic evidence-workflow identification job (2026-09-05, seamless install). Gathers a repository's
 * own facts from GitHub - metadata, the workflow files, package.json scripts, the tsconfig layout -
 * runs the pure identification (src/shadow/workflow-identification.ts) and the eligibility rules the
 * poll container would otherwise discover expensively, and persists the outcome with its evidence.
 *
 * Dependency-injected so the whole decision path is testable against a fake GitHub; validation-worker.ts
 * wires the real fetch with the repository's installation token. Never throws for a repository-shaped
 * problem: every outcome is an identification_status the report can show.
 */
import { identifyEvidenceWorkflow, type IdentificationResult, type WorkflowFile } from "../../shadow/workflow-identification.js";
import type { ShadowStore } from "./shadow-store.js";

export interface RepositoryFacts {
  defaultBranch: string;
  archived: boolean;
  isPrivate: boolean;
  /** Paths of every file under .github/workflows (from the git tree), and that tree's SHA. */
  workflowPaths: string[];
  workflowsTreeSha?: string;
  /** Whether a root tsconfig.json exists, or any nested tsconfig.json (per-package projects). */
  tsconfig: "root" | "nested" | "none" | "unknown";
  hasActionsRuns: boolean;
}

export interface IdentificationGitHub {
  repositoryFacts(repository: string): Promise<RepositoryFacts | { error: string; status?: number }>;
  /** Decoded file content, or undefined when the file does not exist. */
  fileContent(repository: string, path: string, ref: string): Promise<string | undefined>;
}

export interface IdentificationJobDeps {
  store: Pick<ShadowStore, "recordIdentification" | "getIdentification" | "setRepositoryPrivacy" | "setRepositoryStateWithNote">;
  github: IdentificationGitHub;
  nowIso?: () => string;
  log?: (message: string) => void;
}

export interface IdentificationOutcome {
  repository: string;
  status: "identified" | "none_found" | "ineligible" | "explicit" | "error";
  note?: string;
  evidenceWorkflowPaths?: string[];
}

function parseScripts(packageJson: string | undefined): Record<string, string> | undefined {
  if (!packageJson) return undefined;
  try {
    const parsed = JSON.parse(packageJson) as { scripts?: unknown };
    const scripts = parsed.scripts;
    if (!scripts || typeof scripts !== "object") return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(scripts as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return undefined;
  }
}

export async function identifyRepository(deps: IdentificationJobDeps, repository: string): Promise<IdentificationOutcome> {
  const now = deps.nowIso ?? (() => new Date().toISOString());
  const log = deps.log ?? (() => {});
  const existing = await deps.store.getIdentification(repository);
  if (!existing) return { repository, status: "error", note: "repository is not enrolled" };
  if (existing.source === "explicit") {
    await deps.store.recordIdentification({ repository, status: "identified", at: now() }); // records the check time only
    return { repository, status: "explicit", note: "explicit configuration takes precedence" };
  }

  const facts = await deps.github.repositoryFacts(repository);
  if ("error" in facts) {
    const note = `could not read the repository from GitHub (${facts.status ?? "?"}): ${facts.error}`;
    log(`shadow-identify: ${repository}: ${note}`);
    return { repository, status: "error", note };
  }
  await deps.store.setRepositoryPrivacy(repository, facts.isPrivate);

  // Eligibility the poll container would otherwise discover after paying for a launch.
  let ineligible: string | undefined;
  if (facts.archived) ineligible = "repository is archived - it will never produce new commits";
  else if (facts.tsconfig === "none") ineligible = "no tsconfig.json anywhere in the repository - DiffCI's dependency-graph analysis needs a TypeScript project";
  else if (!facts.hasActionsRuns) ineligible = "no GitHub Actions runs yet - there is no CI workload to observe (re-checked automatically)";
  if (ineligible) {
    await deps.store.recordIdentification({ repository, status: "ineligible", note: ineligible, workflowsTreeSha: facts.workflowsTreeSha, at: now() });
    if (facts.archived || facts.tsconfig === "none") await deps.store.setRepositoryStateWithNote(repository, "UNSUPPORTED", ineligible);
    log(`shadow-identify: ${repository}: ineligible - ${ineligible}`);
    return { repository, status: "ineligible", note: ineligible };
  }

  const workflows: WorkflowFile[] = [];
  for (const path of facts.workflowPaths) {
    if (!/\.ya?ml$/i.test(path)) continue;
    const content = await deps.github.fileContent(repository, path, facts.defaultBranch);
    if (content !== undefined) workflows.push({ path, content });
  }
  const packageScripts = parseScripts(await deps.github.fileContent(repository, "package.json", facts.defaultBranch));

  const result: IdentificationResult = identifyEvidenceWorkflow({ workflows, packageScripts, defaultBranch: facts.defaultBranch }, now());
  if (result.status === "NONE_FOUND") {
    await deps.store.recordIdentification({ repository, status: "none_found", note: result.reason, derivationJson: JSON.stringify(result.derivation), workflowsTreeSha: facts.workflowsTreeSha, at: now() });
    log(`shadow-identify: ${repository}: none found - ${result.reason}`);
    return { repository, status: "none_found", note: result.reason };
  }
  const applied = await deps.store.recordIdentification({
    repository,
    status: "identified",
    evidenceWorkflowPaths: result.evidenceWorkflowPaths,
    stageClassificationJson: JSON.stringify(result.stageClassification),
    derivationJson: JSON.stringify(result.derivation),
    note: result.derivation.chosen?.reason,
    workflowsTreeSha: facts.workflowsTreeSha,
    at: now(),
  });
  if (!applied.applied) return { repository, status: "explicit", note: applied.reason };
  // A repository the automatic path found ineligible earlier is observable again once it qualifies.
  if (existing.state === "UNSUPPORTED") await deps.store.setRepositoryStateWithNote(repository, "VALIDATING", undefined);
  log(`shadow-identify: ${repository}: identified ${result.evidenceWorkflowPaths.join(", ")} (${result.derivation.chosen?.reason})`);
  return { repository, status: "identified", note: result.derivation.chosen?.reason, evidenceWorkflowPaths: result.evidenceWorkflowPaths };
}

/** Real GitHub reads for the job. One installation token per repository; every call carries the
 * User-Agent GitHub's API firewall requires from Workers. */
export function makeGitHubIdentificationSource(tokenFor: (repository: string) => Promise<string | undefined>, fetchImpl: typeof fetch = fetch): IdentificationGitHub {
  const headersFor = async (repository: string) => {
    const h: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "diffci-shadow", "X-GitHub-Api-Version": "2026-03-10" };
    const token = await tokenFor(repository);
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  };
  return {
    async repositoryFacts(repository) {
      const headers = await headersFor(repository);
      const metaRes = await fetchImpl(`https://api.github.com/repos/${repository}`, { headers });
      if (!metaRes.ok) return { error: `repository metadata: ${metaRes.status}`, status: metaRes.status };
      const meta = (await metaRes.json()) as { default_branch?: string; archived?: boolean; private?: boolean };
      const defaultBranch = meta.default_branch ?? "main";

      const treeRes = await fetchImpl(`https://api.github.com/repos/${repository}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`, { headers });
      let workflowPaths: string[] = [];
      let workflowsTreeSha: string | undefined;
      let tsconfig: RepositoryFacts["tsconfig"] = "unknown";
      if (treeRes.ok) {
        const tree = (await treeRes.json()) as { tree?: Array<{ path?: string; type?: string; sha?: string }>; truncated?: boolean };
        const entries = tree.tree ?? [];
        workflowPaths = entries.filter((e) => e.type === "blob" && typeof e.path === "string" && e.path.startsWith(".github/workflows/")).map((e) => e.path!);
        workflowsTreeSha = entries.find((e) => e.type === "tree" && e.path === ".github/workflows")?.sha;
        const hasRoot = entries.some((e) => e.type === "blob" && e.path === "tsconfig.json");
        const hasNested = entries.some((e) => e.type === "blob" && typeof e.path === "string" && e.path.endsWith("/tsconfig.json") && !e.path.includes("node_modules/"));
        tsconfig = hasRoot ? "root" : hasNested ? "nested" : tree.truncated ? "unknown" : "none";
      }
      const runsRes = await fetchImpl(`https://api.github.com/repos/${repository}/actions/runs?per_page=1`, { headers });
      const runs = runsRes.ok ? ((await runsRes.json()) as { total_count?: number }) : { total_count: 0 };
      return { defaultBranch, archived: meta.archived === true, isPrivate: meta.private === true, workflowPaths, workflowsTreeSha, tsconfig, hasActionsRuns: (runs.total_count ?? 0) > 0 };
    },
    async fileContent(repository, path, ref) {
      const headers = await headersFor(repository);
      const res = await fetchImpl(`https://api.github.com/repos/${repository}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`, { headers });
      if (res.status === 404) return undefined;
      if (!res.ok) throw new Error(`contents ${path}: ${res.status}`);
      const body = (await res.json()) as { content?: string; encoding?: string };
      if (typeof body.content !== "string") return undefined;
      const raw = body.encoding === "base64" ? atob(body.content.replace(/\n/g, "")) : body.content;
      // atob yields a binary string; workflow files and package.json are UTF-8.
      return new TextDecoder().decode(Uint8Array.from(raw, (c) => c.charCodeAt(0)));
    },
  };
}
