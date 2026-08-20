import { execSync } from "node:child_process";
import { EMPTY_TREE_SHA, isAllZeroSha } from "../git/git-diff.js";

export interface ResolvedCommitRange {
  type: "event" | "cli" | "empty" | "missing";
  baseSha: string | undefined;
  headSha: string | undefined;
  reason: string;
}

export const BASE_EVENT_ENV_MAP = {
  push: ["GITHUB_EVENT_BEFORE"],
  pull_request: ["GITHUB_PR_BASE_SHA", "GITHUB_BASE_SHA"],
  workflow_dispatch: ["GITHUB_BASE_SHA"],
};

export interface ResolveCommitRangeOptions {
  baseArg?: string;
  headArg?: string;
  eventName?: string;
  githubBefore?: string;
  githubSha?: string;
  githubBaseSha?: string;
  prBaseSha?: string;
  repoPath?: string;
  allowLocalFallback?: boolean;
}

function localGitBase(repoPath?: string): string | undefined {
  try {
    return execSync("git rev-parse HEAD^", { cwd: repoPath, encoding: "utf8" }).trim();
  } catch {
    return EMPTY_TREE_SHA;
  }
}

export function resolveCommitRange(options: ResolveCommitRangeOptions): ResolvedCommitRange {
  const head = options.headArg ?? options.githubSha;

  if (!head) {
    return { type: "missing", baseSha: undefined, headSha: undefined, reason: "head SHA is missing" };
  }

  const eventName = options.eventName ?? process.env.GITHUB_EVENT_NAME;

  if (options.baseArg) {
    return { type: "cli", baseSha: options.baseArg, headSha: head, reason: "resolved base from CLI argument" };
  }

  const rawEventBase =
    (eventName === "push" ? options.githubBefore : undefined) ??
    (eventName === "pull_request" ? options.prBaseSha ?? options.githubBaseSha : undefined) ??
    process.env.GITHUB_BASE_SHA;

  if (rawEventBase && isAllZeroSha(rawEventBase)) {
    return {
      type: "empty",
      baseSha: EMPTY_TREE_SHA,
      headSha: head,
      reason: `event base is all-zero (${eventName}); using empty-tree fallback so DiffCI proposes FULL fallback`,
    };
  }

  if (rawEventBase) {
    return {
      type: "event",
      baseSha: rawEventBase,
      headSha: head,
      reason: `resolved base from ${eventName ?? "github-event"} metadata`,
    };
  }

  if (options.allowLocalFallback && (!eventName || eventName === "workflow_dispatch")) {
    const base = localGitBase(options.repoPath);
    return {
      type: base === EMPTY_TREE_SHA ? "empty" : "cli",
      baseSha: base,
      headSha: head,
      reason: `local fallback: using ${base === EMPTY_TREE_SHA ? "empty tree (initial commit)" : "HEAD^"} as base for ${eventName ?? "local CLI"}`,
    };
  }

  return {
    type: "missing",
    baseSha: undefined,
    headSha: head,
    reason: "no event base available and no CLI base provided; DiffCI cannot assume HEAD~1 in CI",
  };
}
