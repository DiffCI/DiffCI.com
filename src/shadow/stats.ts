import { repositoryLayout, UNKNOWN_REPOSITORY_LAYOUT } from "../repo/layout.js";
import type { RepositoryProfile } from "../repo/types.js";

import type { BenchmarkRun, CategoryStats, CommitCategory } from "./types.js";

const DATABASE_DIRECTORIES = new Set(["database", "migrations", "prisma", "drizzle", "supabase", "schema"]);
const CONVENTIONAL_SOURCE_DIRECTORIES = new Set(["src", "lib", "app", "pages", "api", "packages"]);

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function calculateStats(runs: BenchmarkRun[], field: "testReductionPercent") {
  const values = runs.map((r) => r.metrics[field]).filter((v): v is number => typeof v === "number");
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    mean: mean(sorted),
    median: median(sorted),
    p25: percentile(sorted, 25),
    p75: percentile(sorted, 75),
    p90: percentile(sorted, 90),
  };
}

export interface AggregateStats {
  totalCommits: number;
  selectiveCommits: number;
  fallbackCommits: number;
  selectivePercentage: number;
  fallbackPercentage: number;
  meanSelectedTestPercent: number;
  medianSelectedTestPercent: number;
  p25SelectedTestPercent: number;
  p75SelectedTestPercent: number;
  p90SelectedTestPercent: number;
  meanPotentialTestReduction: number;
  medianPotentialTestReduction: number;
  meanPathBaselineReduction: number;
  meanDiffCiAdvantage: number;
}

export function computeAggregateStats(runs: BenchmarkRun[]): AggregateStats {
  const totalCommits = runs.length;
  const selectiveRuns = runs.filter((r) => !r.proposed.fallbackRequired);
  const fallbackRuns = runs.filter((r) => r.proposed.fallbackRequired);
  const selective = calculateStats(selectiveRuns, "testReductionPercent");
  const allReductions = runs.map((r) => r.metrics.testReductionPercent);
  const pathReductions = runs.map((r) => r.metrics.pathBaselineReductionPercent);
  const advantages = runs.map((r) => r.metrics.diffCiAdvantageOverPathPercent);

  return {
    totalCommits,
    selectiveCommits: selectiveRuns.length,
    fallbackCommits: fallbackRuns.length,
    selectivePercentage: totalCommits ? (selectiveRuns.length / totalCommits) * 100 : 0,
    fallbackPercentage: totalCommits ? (fallbackRuns.length / totalCommits) * 100 : 0,
    meanSelectedTestPercent: selective.mean,
    medianSelectedTestPercent: selective.median,
    p25SelectedTestPercent: selective.p25,
    p75SelectedTestPercent: selective.p75,
    p90SelectedTestPercent: selective.p90,
    meanPotentialTestReduction: mean(allReductions),
    medianPotentialTestReduction: percentile(allReductions.slice().sort((a, b) => a - b), 50),
    meanPathBaselineReduction: mean(pathReductions),
    meanDiffCiAdvantage: mean(advantages),
  };
}

/**
 * Which kind of change is this? Used to group benchmark runs, so a wrong answer quietly files a
 * commit under the wrong heading in every aggregate.
 *
 * Phase 01 follow-up (2026-08-26): this categorised by `startsWith("src/")`, `"scripts/"`, `"ops/"`
 * and `"docs/"` - this project's directory names. On a monorepo every commit fell through all four
 * and came back "unknown", so the category breakdown for an external repository was a single bucket
 * that said nothing. The structural guard in tests/planner/repo-agnostic-engine.test.ts found this
 * one; the name-based guard never could, because nothing here names a repository.
 *
 * A profile makes the answer repository-specific; without one the layout-dependent categories are
 * simply not offered, rather than being answered wrongly.
 */
export function categorizeCommit(changedFiles: string[], profile?: RepositoryProfile): CommitCategory {
  const paths = changedFiles.map((p) => p.replace(/\\/g, "/"));
  const layout = profile ? repositoryLayout(profile) : UNKNOWN_REPOSITORY_LAYOUT;

  const isDoc = paths.every((p) => layout.isDocumentationPath(p) || p.startsWith("README"));
  if (isDoc) return "docs-only";

  const isUnder = (p: string, root: string): boolean => p === root || p.startsWith(`${root}/`);
  const declaredSourceRoots = (profile?.sourceRoots ?? [])
    .filter((r) => r.kind === "source" || r.kind === "app" || r.kind === "api")
    .map((r) => r.path.replace(/\\/g, "/").replace(/\/+$/, ""));

  // `fromShadowRecord()` categorises a stored record that carries no profile, so the repository's
  // real roots are unavailable there. Falling back to conventional source-directory NAMES keeps that
  // path working without reintroducing a hardcoded layout: the names are ecosystem-wide, and they
  // are matched as a set against the first path segment rather than as this project's prefixes.
  const hasSrc =
    declaredSourceRoots.length > 0
      ? paths.some((p) => declaredSourceRoots.some((root) => isUnder(p, root)))
      : paths.some((p) => CONVENTIONAL_SOURCE_DIRECTORIES.has(p.split("/")[0] ?? ""));
  const hasScripts = paths.some((p) => layout.isScriptPath(p));
  const hasOps = paths.some((p) => layout.isScriptPath(p) && layout.scriptRoots.some((r) => isUnder(p, r) && r === "ops"));
  const hasDb = paths.some((p) => DATABASE_DIRECTORIES.has(p.split("/")[0] ?? ""));
  const hasConfig = paths.some((p) => /(package\.json|package-lock\.json|tsconfig|next\.config|tailwind\.config|eslint\.config|\.github\/workflows)/.test(p));
  const hasTest = paths.some((p) => /\.(test|spec)\./.test(p));

  const categories: CommitCategory[] = [];
  if (hasConfig) categories.push("config-dependency");
  if (hasDb) categories.push("database");
  if (hasOps) categories.push("infrastructure");
  if (hasScripts) categories.push("scripts");
  if (hasTest) categories.push("test-only");
  if (hasSrc) categories.push("shared-library");

  if (categories.length > 1) return "mixed";
  if (categories.length === 1) return categories[0]!;
  return "unknown";
}

export function computeCategoryStats(runs: BenchmarkRun[]): CategoryStats[] {
  const grouped = new Map<CommitCategory, BenchmarkRun[]>();
  for (const run of runs) {
    const arr = grouped.get(run.commitCategory) ?? [];
    arr.push(run);
    grouped.set(run.commitCategory, arr);
  }

  const result: CategoryStats[] = [];
  for (const [category, group] of grouped.entries()) {
    const selected = group.filter((r) => !r.proposed.fallbackRequired);
    const values = selected.map((r) => r.metrics.testReductionPercent);
    const sorted = values.slice().sort((a, b) => a - b);
    result.push({
      category,
      commits: group.length,
      fallbackRate: group.length ? (group.filter((r) => r.proposed.fallbackRequired).length / group.length) * 100 : 0,
      meanSelectedTestPercent: mean(sorted),
      medianSelectedTestPercent: median(sorted),
    });
  }
  return result.sort((a, b) => b.commits - a.commits);
}
