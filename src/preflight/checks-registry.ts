/**
 * Provider-independent Preflight check registry (Part 8). Each entry is metadata only - nothing here
 * executes a check; execution is explicitly out of scope for P0 (the historical study). This registry is
 * what a future Preflight engine (Part 7) selects from.
 */
import type { FailureClass } from "./taxonomy.js";

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
}

export const PREFLIGHT_CHECK_REGISTRY: readonly PreflightCheckDefinition[] = [
  { id: "typecheck", name: "TypeScript typecheck", estimatedCostUnits: 1, estimatedDurationMs: 8_000, confidence: 0.95, prerequisites: [], failureClassesDetected: ["TYPECHECK"] },
  { id: "lint", name: "Lint", estimatedCostUnits: 1, estimatedDurationMs: 5_000, confidence: 0.9, prerequisites: [], failureClassesDetected: ["LINT"] },
  { id: "dependency_validation", name: "Dependency/lockfile validation", estimatedCostUnits: 1, estimatedDurationMs: 3_000, confidence: 0.85, prerequisites: [], failureClassesDetected: ["DEPENDENCY"] },
  { id: "config_validation", name: "Config/environment-parity validation", estimatedCostUnits: 1, estimatedDurationMs: 2_000, confidence: 0.7, prerequisites: [], failureClassesDetected: ["CONFIGURATION"] },
  { id: "build", name: "Build", estimatedCostUnits: 2, estimatedDurationMs: 20_000, confidence: 0.9, prerequisites: ["typecheck"], failureClassesDetected: ["BUILD", "GENERATED_ARTIFACT"] },
  { id: "affected_tests", name: "Affected/impacted tests (reuses DiffCI Impact Intelligence - Part 20)", estimatedCostUnits: 3, estimatedDurationMs: 15_000, confidence: 0.6, prerequisites: ["typecheck"], failureClassesDetected: ["UNIT_TEST", "INTEGRATION_TEST"] },
  { id: "known_pattern_match", name: "Known-fingerprint match against recent failure history", estimatedCostUnits: 1, estimatedDurationMs: 500, confidence: 0.5, prerequisites: [], failureClassesDetected: ["UNIT_TEST", "INTEGRATION_TEST", "BUILD", "TYPECHECK", "CONFIGURATION", "DEPENDENCY"] },
];

export function getPreflightCheck(id: string): PreflightCheckDefinition | undefined {
  return PREFLIGHT_CHECK_REGISTRY.find((c) => c.id === id);
}
