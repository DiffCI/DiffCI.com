/**
 * Provider-independent Preflight check registry (Part 8). Each entry is metadata only - nothing here
 * executes a check; execution is explicitly out of scope for P0 (the historical study). This registry is
 * what a future Preflight engine (Part 7) selects from.
 */
import type { FailureClass } from "./taxonomy.js";

/** Declarative applicability rule (Preflight P1 Part C) - kept as DATA, not a function, so the
 * registry stays serializable/inspectable/testable without executing arbitrary code, matching this
 * project's "metadata only" discipline for the registry (file header comment). "always" runs on every
 * commit regardless of what changed - required for checks like runtime_parity, where the real
 * 2026-08-22 incident's whole failure mode was that NOTHING in the individual failing commits touched
 * the broken Dockerfile/package.json - the drift was introduced once and then sat broken across six
 * unrelated pushes. A change-triggered rule would have missed every one of those six. */
export type PreflightCheckApplicability = { trigger: "always" } | { trigger: "changed_files_match"; filePatterns: string[] };

export interface PreflightCheckDefinition {
  id: string;
  name: string;
  /** Coarse relative cost, not a dollar figure - reused directly in the risk-ordering heuristic (Part 10). */
  estimatedCostUnits: number;
  estimatedDurationMs: number;
  /** 0-1, how much confidence a PASS on this check buys that the corresponding failure classes won't
   * occur in full CI - deliberately a rough, hand-set starting value (Part 9: "Do NOT begin with a
   * black-box ML model"), meant to be replaced by measured data once shadow Preflight (Phase P1+) runs. */
  confidence: number;
  prerequisites: string[]; // other check ids that must run first, if any
  failureClassesDetected: FailureClass[];
  applicability: PreflightCheckApplicability;
}

export const PREFLIGHT_CHECK_REGISTRY: readonly PreflightCheckDefinition[] = [
  { id: "typecheck", name: "TypeScript typecheck", estimatedCostUnits: 1, estimatedDurationMs: 8_000, confidence: 0.95, prerequisites: [], failureClassesDetected: ["TYPECHECK"], applicability: { trigger: "always" } },
  { id: "lint", name: "Lint", estimatedCostUnits: 1, estimatedDurationMs: 5_000, confidence: 0.9, prerequisites: [], failureClassesDetected: ["LINT"], applicability: { trigger: "always" } },
  {
    id: "runtime_parity",
    name: "Environment/runtime parity check (declared requirement vs. provisioned runtime - see src/preflight/runtime-parity.ts)",
    // Real-measured cost: file parsing only, no process spawned - the live probe that validated this
    // repo's own parity (package.json engines.node vs. the Sandbox image's actual v22.23.2) resolved
    // in well under a second, dwarfed by the ~26s a real runner-registration cycle takes.
    estimatedCostUnits: 1,
    estimatedDurationMs: 200,
    // High but not maximal: the check is deterministic given its inputs, but its coverage is bounded
    // by which sources it knows how to parse (Part B's extractors) - a real requirement declared in an
    // unrecognized form is invisible to it, same honesty as runtime-parity.ts's own MALFORMED/MISSING handling.
    confidence: 0.9,
    prerequisites: [],
    failureClassesDetected: ["CONFIGURATION", "DEPENDENCY"],
    applicability: { trigger: "always" },
  },
  { id: "dependency_validation", name: "Dependency/lockfile validation", estimatedCostUnits: 1, estimatedDurationMs: 3_000, confidence: 0.85, prerequisites: [], failureClassesDetected: ["DEPENDENCY"], applicability: { trigger: "changed_files_match", filePatterns: ["package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"] } },
  { id: "config_validation", name: "Config/environment-parity validation", estimatedCostUnits: 1, estimatedDurationMs: 2_000, confidence: 0.7, prerequisites: [], failureClassesDetected: ["CONFIGURATION"], applicability: { trigger: "changed_files_match", filePatterns: [".env", ".github/workflows/", "wrangler.", "Dockerfile", "tsconfig.json"] } },
  { id: "build", name: "Build", estimatedCostUnits: 2, estimatedDurationMs: 20_000, confidence: 0.9, prerequisites: ["typecheck"], failureClassesDetected: ["BUILD", "GENERATED_ARTIFACT"], applicability: { trigger: "always" } },
  { id: "affected_tests", name: "Affected/impacted tests (reuses DiffCI Impact Intelligence - Part 20)", estimatedCostUnits: 3, estimatedDurationMs: 15_000, confidence: 0.6, prerequisites: ["typecheck"], failureClassesDetected: ["UNIT_TEST", "INTEGRATION_TEST"], applicability: { trigger: "always" } },
  { id: "known_pattern_match", name: "Known-fingerprint match against recent failure history", estimatedCostUnits: 1, estimatedDurationMs: 500, confidence: 0.5, prerequisites: [], failureClassesDetected: ["UNIT_TEST", "INTEGRATION_TEST", "BUILD", "TYPECHECK", "CONFIGURATION", "DEPENDENCY"], applicability: { trigger: "always" } },
];

export function getPreflightCheck(id: string): PreflightCheckDefinition | undefined {
  return PREFLIGHT_CHECK_REGISTRY.find((c) => c.id === id);
}
