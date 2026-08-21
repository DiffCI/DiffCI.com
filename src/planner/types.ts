import type { GitDelta } from "../git/types.js";
import type { ImpactEvidence, ImpactResult } from "../repo/impact-types.js";
import type { RepositoryProfile } from "../repo/types.js";

export type PlanMode = "FULL" | "SELECTIVE";

export type TaskStatus =
  | "ALWAYS_RUN"
  | "RUN"
  | "SKIP_CANDIDATE"
  | "FULL_FALLBACK";

export type TaskCategory =
  | "typecheck"
  | "lint"
  | "test"
  | "build"
  | "security"
  | "infrastructure"
  | "validation"
  | "deploy";

export interface CommandSpec {
  executable: string;
  args: string[];
  env?: Record<string, string>;
}

export interface TaskDecision {
  id: string;
  command: string;
  category: TaskCategory;
  status: TaskStatus;
  reason: string;
  alwaysRun: boolean;
  commandSpec?: CommandSpec;
  triggeredBy: string[];
  /** Stage 2C (2026-08-21) measurement-pipeline repair - see src/research/baseline/test-activity.ts.
   * Purely additive/optional, carried through unchanged from CITaskDefinition; never read by any
   * planning/selection/fallback logic in this file or elsewhere in src/planner|repo|git - only by
   * evidence-collector.ts's filterToTestCategoryTaskIds at reconciliation time, after this plan has been
   * serialized and read back from storage (reconciliation has no repo access to recompute it). */
  hasTestCommand?: boolean;
}

export interface PlanEvidence {
  reason: string;
  source: "impact" | "registry" | "policy" | "fallback";
  file?: string;
  impactEvidence?: ImpactEvidence;
}

export interface PlanSafety {
  graphConfidence: string;
  impactStatus: string;
  fallbackRequired: boolean;
}

export interface ExecutionPlan {
  version: string;
  mode: PlanMode;
  tasks: TaskDecision[];
  selectedTests: string[];
  skippedTests: string[];
  alwaysRunTasks: string[];
  fallbackReasons: string[];
  evidence: PlanEvidence[];
  safety: PlanSafety;
  commandSpecs: CommandSpec[];
}

export interface CIPlannerInput {
  delta: GitDelta;
  impact: ImpactResult;
  profile: RepositoryProfile;
}

export interface CIPlanner {
  plan(input: CIPlannerInput): ExecutionPlan;
}

export interface TestCommandOptions {
  sourceTestRunner?: string;
  conditions?: string[];
}

export { GitDelta, ImpactResult, RepositoryProfile };
