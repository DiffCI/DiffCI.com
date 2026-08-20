import type { ChangedFile } from "../../git/types.js";
import type { CommitCategory,RepositoryMetadata } from "../types.js";
import { runGit } from "./collector.js";

export interface SampledCommit {
  baseSha: string;
  headSha: string;
  messageHeadline: string;
  authorDate: string;
  excluded: boolean;
  exclusionReason?: string;
}

const BOT_PREFIXES = ["dependabot", "renovate", "github-actions", "renovate-bot", "imgbot"];

export function sampleCommits(
  metadata: RepositoryMetadata,
  options: {
    maxCommits: number;
    recentCommitWindow: number;
    excludeMergeCommits: boolean;
    excludeBotCommits: boolean;
  },
): SampledCommit[] {
  if (metadata.exclusionReason) return [];
  const args = ["log", "--pretty=format:%H%x00%P%x00%s%x00%aI%n"];
  if (options.excludeMergeCommits) args.push("--no-merges");
  // Prefer recent active commits.
  args.push("-n", String(options.recentCommitWindow));
  args.push(metadata.defaultBranch || "HEAD");

  let raw: string;
  try {
    raw = runGit(args, metadata.localPath);
  } catch (error: unknown) {
    return [];
  }

  const lines = raw.split("\n").filter(Boolean);
  const sampled: SampledCommit[] = [];

  for (const line of lines) {
    if (sampled.length >= options.maxCommits) break;
    const [headSha, parents, message, authorDate] = line.split("\x00");
    if (!headSha || !parents) continue;
    const parentShas = parents.split(" ");
    if (parentShas[0] === "" || parentShas.length === 0) continue;
    const baseSha = parentShas[0];

    const excluded = isExcludedCommit(message || "", options.excludeBotCommits);
    if (excluded.excluded) continue;

    sampled.push({
      baseSha,
      headSha,
      messageHeadline: message || "",
      authorDate: authorDate || "",
      excluded: false,
    });
  }

  return sampled;
}

function isExcludedCommit(message: string, excludeBotCommits: boolean): { excluded: boolean; reason?: string } {
  const lower = message.toLowerCase();
  if (excludeBotCommits && BOT_PREFIXES.some((p) => lower.includes(p))) {
    return { excluded: true, reason: "bot commit" };
  }
  if (/\brevert\b/i.test(message)) {
    return { excluded: true, reason: "revert commit" };
  }
  return { excluded: false };
}

export function classifyCommit(changedFiles: ChangedFile[]): CommitCategory {
  const paths = changedFiles.map((f) => f.path.replace(/\\/g, "/"));
  const lower = paths.join(" ");
  const extensions = new Set(paths.map((p) => p.split(".").pop()?.toLowerCase() ?? ""));

  if (paths.every((p) => p.endsWith(".md") || p.endsWith(".mdx") || p.startsWith("README"))) return "documentation";
  if (extensions.has("yml") || extensions.has("yaml") || lower.includes("package.json") || lower.includes("tsconfig")) {
    if (!extensions.has("ts") && !extensions.has("tsx") && !extensions.has("js") && !extensions.has("jsx")) return "configuration";
  }
  if (lower.includes("package-lock") || lower.includes("yarn.lock") || lower.includes("pnpm-lock") || lower.includes("bun.lock")) return "dependency";
  if (paths.some((p) => p.startsWith(".github/"))) return "infrastructure";
  if (paths.some((p) => p.startsWith("ops/") || p.startsWith("terraform/") || p.includes("dockerfile") || p.startsWith("docker"))) return "infrastructure";
  if (paths.some((p) => p.startsWith("database/") || p.startsWith("migrations/"))) return "database";
  if (paths.every((p) => /\.(png|jpg|jpeg|svg|gif|webp|ico|woff|ttf|css|scss|json)$/i.test(p))) return "assets";
  if (paths.some((p) => p.includes("test") || p.includes("spec")) && paths.every((p) => /\.(test|spec)\./i.test(p))) return "test-only";

  const frontend = paths.some((p) => /\.(tsx|jsx|css|scss)$/i.test(p));
  const backend = paths.some((p) => /\.(ts|js|mjs|cjs)$/i.test(p) && !/\.(tsx|jsx)$/i.test(p));
  const sharedLib = paths.some((p) => p.includes("lib/") || p.includes("shared/") || p.includes("common/"));

  if (frontend && backend && sharedLib) return "shared-library";
  if (frontend && backend) return "mixed";
  if (frontend) return sharedLib ? "frontend-shared" : "frontend-isolated";
  if (backend) return sharedLib ? "backend-shared" : "backend-isolated";

  if (paths.some((p) => p.includes("api"))) return "api";

  if (changedFiles.some((f) => f.changeType === "deleted")) return "deletion";
  if (changedFiles.some((f) => f.changeType === "renamed")) return "rename";

  return "unknown";
}
