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
