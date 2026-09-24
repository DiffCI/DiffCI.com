import type { SandboxLike } from "../analysis-fanout/sandbox-like.js";
import { createAdoptionPullRequest, type AdoptionChange, type AdoptionPullRequestResult } from "./adoption-pr.js";

const WORKSPACE = "/workspace/diffci-adoption";
const GENERATED_PATHS = [
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb",
  "AGENTS.md", "CLAUDE.md", ".cursor/rules/diffci.mdc", ".github/copilot-instructions.md",
  "diffci.config.json", ".github/workflows/diffci.yml",
] as const;
const LOCKFILES = new Set(["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"]);
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export interface AdoptionGenerationInput {
  repository: string;
  baseBranch: string;
  installationToken: string;
  diffciVersion: string;
}

function assertIdentifier(value: string, label: string, pattern: RegExp): void {
  if (!pattern.test(value)) throw new Error(`unsafe ${label} ${JSON.stringify(value)}`);
}

async function requiredExec(sandbox: SandboxLike, command: string, options?: { timeout?: number; cwd?: string; env?: Record<string, string> }): Promise<string> {
  const result = await sandbox.exec(command, options);
  if (!result.success || result.exitCode !== 0) throw new Error(`adoption generation command failed (${result.exitCode}): ${result.stderr.slice(-500)}`);
  return result.stdout;
}

/** Generate dependency, lockfile, agent instructions and workflow inside a disposable container. */
export async function generateAdoptionChanges(sandbox: SandboxLike, input: AdoptionGenerationInput): Promise<AdoptionChange[]> {
  assertIdentifier(input.repository, "repository", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assertIdentifier(input.baseBranch, "base branch", /^[A-Za-z0-9._/-]+$/);
  if (input.baseBranch.startsWith("-") || input.baseBranch.includes("..")) throw new Error(`unsafe base branch ${JSON.stringify(input.baseBranch)}`);
  assertIdentifier(input.diffciVersion, "DiffCI version", /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  try {
    await requiredExec(sandbox, `rm -rf ${WORKSPACE} && mkdir -p ${WORKSPACE}`, { timeout: 30_000 });
    await requiredExec(
      sandbox,
      `git clone --depth 1 --branch ${input.baseBranch} https://github.com/${input.repository}.git ${WORKSPACE}/repo`,
      {
        timeout: 10 * 60_000,
        env: {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.extraHeader",
          GIT_CONFIG_VALUE_0: `Authorization: Bearer ${input.installationToken}`,
        },
      },
    );
    await requiredExec(
      sandbox,
      `npx --yes @diffci.com/diffci@${input.diffciVersion} init --install --workflow --repo ${WORKSPACE}/repo`,
      { timeout: 10 * 60_000, cwd: `${WORKSPACE}/repo` },
    );
    await requiredExec(sandbox, `npx --no-install diffci verify-workflow --repo ${WORKSPACE}/repo`, { timeout: 60_000, cwd: `${WORKSPACE}/repo` });

    const changes: AdoptionChange[] = [];
    for (const path of GENERATED_PATHS) {
      const status = await requiredExec(sandbox, `git status --porcelain -- ${path}`, { timeout: 15_000, cwd: `${WORKSPACE}/repo` });
      if (!status.trim()) continue;
      const file = await sandbox.readFile(`${WORKSPACE}/repo/${path}`);
      const content = file.content;
      if (content.includes("\0")) throw new Error(`generated file is not text: ${path}`);
      if (new TextEncoder().encode(content).byteLength > MAX_FILE_BYTES) throw new Error(`generated file is too large: ${path}`);
      changes.push({ path, content });
    }
    const unexpected = await requiredExec(sandbox, "git status --porcelain --untracked-files=all", { timeout: 15_000, cwd: `${WORKSPACE}/repo` });
    const unexpectedPaths = unexpected.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3)).filter((path) => !GENERATED_PATHS.includes(path as typeof GENERATED_PATHS[number]));
    if (unexpectedPaths.length > 0) throw new Error(`initializer changed non-allowlisted files: ${unexpectedPaths.join(", ")}`);
    if (!changes.some((change) => change.path === "package.json")) throw new Error("initializer did not produce a package.json dependency change");
    if (!changes.some((change) => LOCKFILES.has(change.path))) throw new Error("initializer did not produce a lockfile change");
    if (!changes.some((change) => change.path === ".github/workflows/diffci.yml")) throw new Error("initializer did not produce the DiffCI workflow");
    return changes;
  } finally {
    await sandbox.destroy();
  }
}

export async function generateAndPublishAdoptionPullRequest(
  sandbox: SandboxLike,
  input: AdoptionGenerationInput & { branch: string },
  fetchFn: typeof fetch = fetch,
): Promise<AdoptionPullRequestResult> {
  const changes = await generateAdoptionChanges(sandbox, input);
  return createAdoptionPullRequest({
    installationToken: input.installationToken,
    repository: input.repository,
    baseBranch: input.baseBranch,
    branch: input.branch,
    title: "Add DiffCI observation",
    commitMessage: "ci: add DiffCI observation",
    body: "Adds DiffCI as an exact development dependency and a separate, non-blocking observation workflow. Existing required CI remains unchanged. This pull request was opened as a draft for maintainer review.",
    changes,
  }, fetchFn);
}
