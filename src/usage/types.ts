export type UsageEventType =
  | "prediction"
  | "ci_run_analyzed"
  | "tests_considered"
  | "tests_selected"
  | "estimated_compute_seconds"
  | "runner_seconds"
  | "runner_job"
  | "repository_active";

export interface UsageEvent {
  id: string;
  organizationId: string;
  repositoryId?: string;
  eventType: UsageEventType;
  quantity: number;
  unit: string;
  sourceType: string;
  sourceId: string;
  occurredAt: string;
  recordedAt: string;
  idempotencyKey: string;
}

export interface RecordUsageEventInput {
  organizationId: string;
  repositoryId?: string;
  eventType: UsageEventType;
  quantity: number;
  unit: string;
  sourceType: string;
  sourceId: string;
  occurredAt: string;
}

export interface UsageSummary {
  organizationId: string;
  periodStart: string;
  periodEnd: string;
  ciRunsAnalyzed: number;
  predictions: number;
  testsConsidered: number;
  testsSelected: number;
  estimatedComputeSeconds: number;
  runnerSeconds: number;
  runnerJobs: number;
  activeRepositories: number;
}
