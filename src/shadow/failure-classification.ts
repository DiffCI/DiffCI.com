/**
 * Stage 2 Phase 6 failure classification: not every failed GitHub job is a safety-relevant test
 * regression - an infra flake, a rate limit, or a broken external dependency shouldn't count as a
 * DiffCI "unsafe miss" the same way a real test failure does. Classification is deliberately
 * conservative: when the evidence doesn't clearly indicate a category, this returns "UNKNOWN" rather
 * than guessing - per the task spec's explicit "do not invent classifications when evidence is
 * insufficient."
 */
import type { CITaskCategory } from "../planner/task-registry.js";
import type { FlakinessCheckResult } from "../research/historical/flakiness-check.js";

export type FailureCategory =
  | "TEST_FAILURE"
  | "BUILD_FAILURE"
  | "TYPECHECK_FAILURE"
  | "LINT_FAILURE"
  | "INFRASTRUCTURE_FAILURE"
  | "RATE_LIMIT"
  | "FLAKY_FAILURE"
  | "EXTERNAL_SERVICE"
  | "CONFIGURATION_FAILURE"
  | "UNKNOWN";

const CATEGORY_BY_TASK_CATEGORY: Partial<Record<CITaskCategory, FailureCategory>> = {
  test: "TEST_FAILURE",
  build: "BUILD_FAILURE",
  typecheck: "TYPECHECK_FAILURE",
  lint: "LINT_FAILURE",
};

interface TextHeuristic {
  category: FailureCategory;
  patterns: RegExp[];
}

// Ordered - the first matching heuristic wins. Deliberately narrow patterns (real GitHub Actions/npm/
// network error vocabulary) rather than broad guesses, so an ambiguous message falls through to UNKNOWN
// instead of being force-fit into a category.
const TEXT_HEURISTICS: TextHeuristic[] = [
  { category: "RATE_LIMIT", patterns: [/rate limit/i, /\b429\b/i, /abuse detection/i, /secondary rate limit/i] },
  {
    category: "INFRASTRUCTURE_FAILURE",
    patterns: [/runner has received a shutdown signal/i, /lost communication with the server/i, /econnreset/i, /etimedout/i, /the job was canceled because/i, /out of disk space/i, /no space left on device/i],
  },
  {
    category: "EXTERNAL_SERVICE",
    patterns: [/registry\.npmjs\.org/i, /docker\.io/i, /could not resolve host/i, /getaddrinfo enotfound/i, /service unavailable/i, /\b503\b/i],
  },
  {
    category: "CONFIGURATION_FAILURE",
    patterns: [/environment variable .* is not set/i, /missing required secret/i, /invalid configuration/i, /config(?:uration)? error/i],
  },
];

export interface ClassifyFailureInput {
  /** The task category DiffCI's own registry assigned this job/step to, when known. */
  taskCategory?: CITaskCategory;
  /** Raw step/job name and any captured error text, used only when taskCategory doesn't resolve it. */
  stepName?: string;
  errorText?: string;
  /** Result of a cross-attempt flakiness check (src/research/historical/flakiness-check.ts), if run. */
  flakinessResult?: FlakinessCheckResult;
}

/**
 * Flakiness takes precedence over a raw category match when both are available: "this job is known
 * flaky across nearby commits" is a stronger, more actionable signal for the safety-recall calculation
 * than "it happens to be a test job" - a flaky test failure is not the same safety event as a genuine
 * regression a test caught, even though both would nominally classify as TEST_FAILURE by category alone.
 */
export function classifyFailure(input: ClassifyFailureInput): FailureCategory {
  if (input.flakinessResult?.likelyFlaky) return "FLAKY_FAILURE";

  if (input.taskCategory && CATEGORY_BY_TASK_CATEGORY[input.taskCategory]) {
    return CATEGORY_BY_TASK_CATEGORY[input.taskCategory]!;
  }

  const haystack = `${input.stepName ?? ""} ${input.errorText ?? ""}`;
  for (const heuristic of TEXT_HEURISTICS) {
    if (heuristic.patterns.some((pattern) => pattern.test(haystack))) return heuristic.category;
  }

  return "UNKNOWN";
}
