import type { ImpactResult } from "../repo/impact-types.js";
import type { RepositoryProfile } from "../repo/types.js";
import { generateSelectiveTestCommandSpecs } from "./selective-commands.js";
import type { CITaskDefinition, TaskRegistry } from "./task-registry.js";
import type { CIPlanner, CIPlannerInput, ExecutionPlan, PlanEvidence, TaskDecision, TaskStatus } from "./types.js";

const PLAN_VERSION = "5.0.0";

function expandBraces(pattern: string): string[] {
  const match = /\{([^{}]*)\}/.exec(pattern);
  if (!match) return [pattern];
  const prefix = pattern.slice(0, match.index);
  const suffix = pattern.slice((match.index ?? 0) + match[0].length);
  const alternatives = match[1]!.split(",");
  const result: string[] = [];
  for (const alt of alternatives) {
    result.push(...expandBraces(`${prefix}${alt}${suffix}`));
  }
  return result;
}

function regexFrom(pattern: string): RegExp {
  let escaped = pattern.replace(/\\/g, "\\\\").replace(/\./g, "\\.");
  // Protect the multi-segment globstar sequences behind placeholders before the
  // single-`*` replace runs below - otherwise the `*` inside "(?:.*/)?"/"(?:/.*)?" gets
  // re-matched and mangled by that same replace (e.g. "src/**/*.test.ts" would wrongly
  // fail to match files nested two or more directories under src/, since the resulting
  // regex only reliably matched zero or one intervening path segment).
  escaped = escaped
    .replace(/\*\*\//g, "\0GLOBSTAR_SLASH\0")
    .replace(/\/\*\*/g, "\0SLASH_GLOBSTAR\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\0GLOBSTAR_SLASH\0/g, "(?:.*/)?")
    .replace(/\0SLASH_GLOBSTAR\0/g, "(?:/.*)?");
  return new RegExp(`^${escaped}$`);
}

function matches(path: string, pattern: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return expandBraces(pattern).some((p) => regexFrom(p).test(normalized));
}

function matchesAny(path: string, patterns: string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((p) => matches(path, p));
}

function toPosix(p: string): string { return p.replace(/\\/g, "/"); }

export class DefaultCIPlanner implements CIPlanner {
  private readonly taskRegistry: TaskRegistry;
  private readonly alwaysRunIds: Set<string>;

  constructor(taskRegistry: TaskRegistry) {
    this.taskRegistry = taskRegistry;
    this.alwaysRunIds = new Set(taskRegistry.alwaysRunTasks().map((t) => t.id));
  }

  plan(input: CIPlannerInput): ExecutionPlan {
    const { delta, impact, profile } = input;
    const changedPaths = delta.files.map((f) => toPosix(f.path));
    const fallbackRequired = impact.fallbackRequired;
    const mode = fallbackRequired ? "FULL" : "SELECTIVE";
    const allTestPaths = this.allTestPaths(profile);
    const selectedTests = fallbackRequired ? allTestPaths : impact.affectedTests.map((t) => t.path);
    const skippedTests = fallbackRequired ? [] : allTestPaths.filter((p) => !selectedTests.includes(p));
    const tasks = this.buildTasks(fallbackRequired, changedPaths, impact, selectedTests, allTestPaths);
    const alwaysRunTasks = tasks.filter((t) => t.status === "ALWAYS_RUN").map((t) => t.id);
    const commandSpecs = fallbackRequired ? [] : generateSelectiveTestCommandSpecs(selectedTests);

    return {
      version: PLAN_VERSION,
      mode,
      tasks,
      selectedTests,
      skippedTests,
      alwaysRunTasks,
      fallbackReasons: impact.fallbackReasons,
      evidence: this.collectEvidence(impact),
      safety: {
        // Stage 1B fix (2026-08-21): this previously checked impact.changedFiles[].reasons for
        // "GRAPH_CONFIDENCE_UNSAFE" - a condition that could never be true, since that reason is only
        // ever pushed to impact.riskSignals (a global list), never into any changedFile's own reasons
        // array (see changedFileReasons() in impact.ts, which only ever returns DIRECT_CHANGE/
        // DELETED_FILE_LEGACY_DEPENDENTS/RENAMED_FILE_LEGACY_IDENTITY). This field had silently always
        // reported "COMPLETE" regardless of actual graph confidence - a real, pre-existing display/
        // observability bug discovered while wiring in per-delta confidence refinement, fixed here as
        // part of the same change since it's the same code path. Did not affect actual safety behavior
        // - fallbackRequired/mode below were always correctly gated by the real confidence value.
        graphConfidence: impact.effectiveGraphConfidence,
        impactStatus: impact.analysisStatus,
        fallbackRequired,
      },
      commandSpecs,
    };
  }

  private allTestPaths(profile: RepositoryProfile): string[] {
    // Real individual test file paths, not the glob patterns in profile.tests (those are
    // aggregate glob+count summaries, e.g. "**/*.test.ts" - comparing them against real
    // file paths elsewhere, as selectedTests/skippedTests do, would never match).
    return Array.from(new Set(profile.testFilePaths)).sort();
  }

  private collectEvidence(impact: ImpactResult): PlanEvidence[] {
    const evidence: PlanEvidence[] = [];
    for (const e of impact.evidence) evidence.push({ reason: e.reason, source: "impact", file: e.affectedFile });
    if (impact.fallbackRequired) {
      for (const reason of impact.fallbackReasons) evidence.push({ reason: "FALLBACK", source: "fallback", file: reason });
    }
    for (const task of this.taskRegistry.alwaysRunTasks()) evidence.push({ reason: "ALWAYS_RUN_POLICY", source: "policy", file: task.id });
    return evidence;
  }

  private buildTasks(fallbackRequired: boolean, changedPaths: string[], impact: ImpactResult, selectedTests: string[], allTestPaths: string[]): TaskDecision[] {
    return this.taskRegistry.all().map((task) => {
      const alwaysRun = this.alwaysRunIds.has(task.id);
      let status: TaskStatus;
      let reason: string;
      const triggeredBy: string[] = [];

      if (fallbackRequired) {
        status = alwaysRun ? "ALWAYS_RUN" : "FULL_FALLBACK";
        reason = `Full fallback triggered: ${impact.fallbackReasons.join("; ") || "global risk signal"}`;
      } else if (alwaysRun) {
        status = "ALWAYS_RUN";
        reason = `Always-run policy: ${task.description || task.id}`;
      } else if (this.triggered(task, changedPaths, impact)) {
        status = "RUN";
        reason = `Triggered by changed files matching ${task.id} input patterns`;
        triggeredBy.push(...changedPaths.filter((p) => matchesAny(p, task.inputPatterns)));
      } else if (task.category === "test" && selectedTests.length < allTestPaths.length) {
        status = "SKIP_CANDIDATE";
        reason = "No affected tests matched this task via changed files in current delta";
      } else {
        status = "SKIP_CANDIDATE";
        reason = "No matching changed files and task is not always-run";
      }

      return { id: task.id, command: task.command, category: task.category, status, reason, alwaysRun, triggeredBy };
    });
  }

  private triggered(task: CITaskDefinition, changedPaths: string[], impact: ImpactResult): boolean {
    if (changedPaths.some((p) => matchesAny(p, task.inputPatterns))) return true;
    if (task.globalRiskTriggers) {
      for (const signal of impact.riskSignals) { if (task.globalRiskTriggers.includes(signal.reason)) return true; }
    }
    return false;
  }
}
