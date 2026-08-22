import type { FailureClass } from "./taxonomy.js";
import type { PreventabilityClass } from "./preventability.js";

/**
 * One row of the Preflight historical research dataset (Part 2). Deliberately a SEPARATE record type
 * and store from Stage 2F's shadow_predictions/shadow_ground_truth - never written by, and never
 * writable into, those tables (Part 25).
 */
export interface HistoricalFailureRecord {
  repository: string;
  commitSha: string;
  changedFiles: string[];
  changedLinesCount?: number;
  workflow: string;
  job: string;
  failingStep?: string;
  failureClass: FailureClass;
  failingTest?: string;
  errorFingerprint: string;
  timeToFailureMs?: number;
  totalWorkflowDurationMs?: number;
  previousSuccessfulCommitSha?: string;
  diffciPredictionExisted: boolean;
  diffciPredictionMode?: "FULL" | "SELECTIVE";
  diffciSelectedTests?: string[];
  dependencyRelationships?: string[];
  isDeterministic?: boolean;
  retrySucceededWithoutSourceChange?: boolean;
  preventability: PreventabilityClass;
  preventabilityReason: string;
  runId: string;
  runCreatedAt: string;
}
