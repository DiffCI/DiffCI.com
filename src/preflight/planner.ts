/**
 * Deterministic Preflight check-selection planner (Preflight P1 Part C). Selects and orders checks
 * from PREFLIGHT_CHECK_REGISTRY for a given commit's changed files. Deliberately rule-based, not
 * learned - same discipline as risk-model.ts (Part 9: "Do NOT begin with a black-box ML model"): given
 * the same changedFiles input, this always produces the exact same plan, and every inclusion/exclusion
 * is explainable from the registry's own declared applicability/prerequisite data, nothing hidden.
 */
import { PREFLIGHT_CHECK_REGISTRY, type PreflightCheckDefinition } from "./checks-registry.js";

export interface PlannedCheck {
  check: PreflightCheckDefinition;
  /** Why this check was included: directly applicable to the diff, or pulled in only because a
   * selected check depends on it. Both are legitimate, explainable reasons - never a silent inclusion. */
  reason: "applicable" | "prerequisite_of_applicable_check";
}

export interface PreflightPlan {
  checks: PlannedCheck[];
  totalEstimatedCostUnits: number;
  totalEstimatedDurationMs: number;
}

/** Simple, dependency-free file-pattern match: a pattern ending in "/" matches any changed file whose
 * path starts with that prefix; any other pattern matches a changed file whose path contains it as a
 * literal substring (covers exact filenames like "package.json" and stem matches like "wrangler." for
 * every wrangler.*.jsonc config). Deliberately not a full glob engine - the registry's own patterns
 * are simple enough that a glob library would add a dependency for no real benefit here. */
export function matchesFilePattern(changedFile: string, pattern: string): boolean {
  const normalized = changedFile.replace(/\\/g, "/");
  if (pattern.endsWith("/")) return normalized.startsWith(pattern) || normalized.includes(`/${pattern}`);
  return normalized === pattern || normalized.endsWith(`/${pattern}`) || normalized.includes(pattern);
}

function isApplicable(check: PreflightCheckDefinition, changedFiles: string[]): boolean {
  const applicability = check.applicability;
  if (applicability.trigger === "always") return true;
  return changedFiles.some((f) => applicability.filePatterns.some((p) => matchesFilePattern(f, p)));
}

/**
 * Builds the full, prerequisite-closed set of check ids that must run for `directlyApplicable` to be
 * satisfiable, then orders them via a deterministic topological sort (Kahn's algorithm): at each step,
 * among every check whose prerequisites are already scheduled, the LOWEST estimatedCostUnits check
 * runs next (tie-broken by check id, alphabetically) - cheap, high-signal checks surface first,
 * matching Part 10's cost-ordering heuristic, while staying fully deterministic and explainable.
 *
 * Throws if the registry itself contains a prerequisite cycle or a reference to an unknown check id -
 * a real configuration bug, not something to silently work around.
 */
export function planPreflightChecks(changedFiles: string[], registry: readonly PreflightCheckDefinition[] = PREFLIGHT_CHECK_REGISTRY): PreflightPlan {
  const byId = new Map(registry.map((c) => [c.id, c]));
  const directlyApplicable = new Set(registry.filter((c) => isApplicable(c, changedFiles)).map((c) => c.id));

  // Close over prerequisites transitively.
  const selected = new Set<string>();
  const reasonFor = new Map<string, PlannedCheck["reason"]>();
  const stack = [...directlyApplicable];
  while (stack.length > 0) {
    const id = stack.pop()!;
    const check = byId.get(id);
    if (!check) throw new Error(`preflight planner: unknown check id "${id}" referenced (registry bug)`);
    if (!selected.has(id)) {
      selected.add(id);
      reasonFor.set(id, directlyApplicable.has(id) ? "applicable" : "prerequisite_of_applicable_check");
    }
    for (const prereqId of check.prerequisites) {
      if (!selected.has(prereqId)) stack.push(prereqId);
    }
  }

  // Kahn's algorithm over the selected subgraph.
  const remaining = new Set(selected);
  const ordered: PreflightCheckDefinition[] = [];
  const inDegreeSatisfied = (id: string) => byId.get(id)!.prerequisites.every((p) => !remaining.has(p) || ordered.some((o) => o.id === p));

  while (remaining.size > 0) {
    const runnable = [...remaining].filter(inDegreeSatisfied);
    if (runnable.length === 0) {
      throw new Error(`preflight planner: prerequisite cycle detected among checks [${[...remaining].join(", ")}] (registry bug)`);
    }
    runnable.sort((a, b) => {
      const ca = byId.get(a)!;
      const cb = byId.get(b)!;
      if (ca.estimatedCostUnits !== cb.estimatedCostUnits) return ca.estimatedCostUnits - cb.estimatedCostUnits;
      return a.localeCompare(b);
    });
    const next = runnable[0]!;
    ordered.push(byId.get(next)!);
    remaining.delete(next);
  }

  const checks: PlannedCheck[] = ordered.map((check) => ({ check, reason: reasonFor.get(check.id)! }));
  return {
    checks,
    totalEstimatedCostUnits: checks.reduce((sum, c) => sum + c.check.estimatedCostUnits, 0),
    totalEstimatedDurationMs: checks.reduce((sum, c) => sum + c.check.estimatedDurationMs, 0),
  };
}
