/**
 * Decision layer for the ephemeral self-hosted runner fleet (2026-09-05, measurement-integrity repair
 * step 4). Pure and plain-Node-testable; github-runner-worker.ts wires GitHub, the Queue, D1 and the
 * container.
 *
 * Two defects this replaces (live tail, 2026-09-05T07:09Z, research note "Fix 4"):
 *   1. Dispatch ran inside the webhook's ctx.waitUntil(), cancelled ~30 s after the response - no
 *      durable record of what happened to any runner, and a dispatch that failed to start left no trace.
 *      Dispatch now runs from a Queue consumer (15-minute invocation limit) and every stage is recorded.
 *   2. Every runner registered with the same labels, so GitHub gave each new runner the OLDEST queued
 *      job: a runner spawned for one job executed another, and new work was starved by the backlog.
 *      Workflows now carry a job-unique label (runs-on "diffci-job-<run id>-<job>") and the runner is
 *      registered with the job's full label set, so it can only be assigned that job.
 *
 * Success condition (founder): for a controlled new commit the evidence workflow progresses
 * queued -> runner assigned -> executing -> terminal with no subsequent push; twice in a row.
 */

export type RunnerLifecycleStage =
  | "workflow_queued" // workflow_job.queued delivered
  | "dispatch_requested" // message enqueued for the consumer
  | "dispatch_started" // consumer picked the message up
  | "token_minted"
  | "container_started" // sandbox.exec() began
  | "runner_registered" // seen online in GitHub's runner list (reconcile) or inferred from assignment
  | "job_assigned" // workflow_job.in_progress delivered
  | "execution_completed" // workflow_job.completed delivered
  | "runner_disposed" // sandbox.exec() resolved / failed / timed out
  | "dispatch_failed"; // token or container start failed

export type RunnerDisposition = "exec-succeeded" | "exec-failed" | "exec-timeout" | "start-failed" | "capacity" | "token-failed";

export const CLAIM_LABELS = ["self-hosted", "cloudflare"] as const;
/** The job-unique label prefix workflows use: runs-on [self-hosted, cloudflare, "diffci-job-<run id>-<job>"]. */
export const PINNED_LABEL_PREFIX = "diffci-job-";

export interface DispatchMessage {
  jobId: number;
  owner: string;
  repo: string;
  installationId: number;
  labels: string[];
  workflowRunId?: number;
  source: "webhook" | "reconcile";
}

export function parseDispatchMessage(body: unknown): DispatchMessage | undefined {
  if (!body || typeof body !== "object") return undefined;
  const o = body as Record<string, unknown>;
  if (typeof o.jobId !== "number" || !Number.isFinite(o.jobId)) return undefined;
  if (typeof o.owner !== "string" || !/^[\w.-]{1,100}$/.test(o.owner)) return undefined;
  if (typeof o.repo !== "string" || !/^[\w.-]{1,100}$/.test(o.repo)) return undefined;
  if (typeof o.installationId !== "number" || !Number.isFinite(o.installationId)) return undefined;
  const labels = Array.isArray(o.labels) ? o.labels.filter((l): l is string => typeof l === "string" && /^[A-Za-z0-9._-]{1,256}$/.test(l)) : [];
  const source = o.source === "reconcile" ? "reconcile" : "webhook";
  const workflowRunId = typeof o.workflowRunId === "number" ? o.workflowRunId : undefined;
  return { jobId: o.jobId, owner: o.owner, repo: o.repo, installationId: o.installationId, labels, workflowRunId, source };
}

/** Only jobs that ask for this fleet's labels are ours; everything else is GitHub-hosted or another fleet. */
export function jobAddressedToFleet(labels: readonly string[]): boolean {
  return CLAIM_LABELS.every((l) => labels.includes(l));
}

export function isPinned(labels: readonly string[]): boolean {
  return labels.some((l) => l.startsWith(PINNED_LABEL_PREFIX));
}

/**
 * The labels the runner registers with. The job's own labels, in order, minus GitHub's implicit
 * defaults (`self-hosted` and the OS/arch labels are added by the runner itself and were tolerated
 * when passed explicitly, but the pinned label is what matters): a pinned job's runner carries its
 * unique label and can only ever be assigned that job; a legacy plain-label job's runner carries the
 * plain labels and takes GitHub's oldest matching job, exactly as before.
 */
export function registrationLabels(labels: readonly string[]): string[] {
  const custom = labels.filter((l) => l !== "self-hosted" && l !== "linux" && l !== "x64" && l !== "X64" && l !== "Linux");
  if (!custom.includes("cloudflare")) custom.unshift("cloudflare");
  return custom;
}

export interface QueuedJobView {
  jobId: number;
  workflowRunId: number;
  labels: string[];
  /** GitHub's created_at for the job. */
  queuedAt: string;
}

export interface LifecycleView {
  jobId: number;
  dispatchRequestedAt?: string;
  containerStartedAt?: string;
  assignedAt?: string;
  executionCompletedAt?: string;
  disposition?: string;
  dispatchAttempts: number;
}

export interface ReconcileDecision {
  jobId: number;
  /** runner_gone: the dispatched runner's exec resolved (the ephemeral runner exited) yet GitHub never
   * assigned it this job - while legacy plain-label jobs remain queued, GitHub may hand them a pinned
   * runner (a pinned runner's labels are a superset of theirs). The job certainly has no runner now. */
  reason: "never_dispatched" | "dispatch_failed" | "dispatch_stale" | "runner_gone";
}

/** A dispatch older than this without an assignment is presumed lost (container capacity, cancelled
 * consumer, registration that never came online). Longer than any healthy setup (~30-60 s). */
export const STALE_DISPATCH_MS = 15 * 60 * 1000;
/** Jobs younger than this are left to the webhook path - the reconciler must not race it. */
export const MIN_QUEUED_AGE_MS = 2 * 60 * 1000;
export const MAX_DISPATCH_ATTEMPTS = 3;

/**
 * Which queued jobs the reconciler should (re)dispatch. Pure: GitHub's queued jobs and our lifecycle
 * rows in, decisions out. The cap keeps a starved queue from spawning more containers than the
 * application can hold (github-runner-worker.ts passes the remaining capacity).
 */
export function decideReconcileDispatches(
  queued: readonly QueuedJobView[],
  lifecycle: ReadonlyMap<number, LifecycleView>,
  nowIso: string,
  capacity: number,
): ReconcileDecision[] {
  const nowMs = Date.parse(nowIso);
  const decisions: ReconcileDecision[] = [];
  const byAge = [...queued].sort((a, b) => Date.parse(a.queuedAt) - Date.parse(b.queuedAt));
  for (const job of byAge) {
    if (decisions.length >= capacity) break;
    if (!jobAddressedToFleet(job.labels)) continue;
    if (nowMs - Date.parse(job.queuedAt) < MIN_QUEUED_AGE_MS) continue;
    const row = lifecycle.get(job.jobId);
    if (row?.assignedAt || row?.executionCompletedAt) continue; // GitHub says queued but we saw progress - let the completed webhook settle it
    if (!row || !row.dispatchRequestedAt) {
      decisions.push({ jobId: job.jobId, reason: "never_dispatched" });
      continue;
    }
    if (row.dispatchAttempts >= MAX_DISPATCH_ATTEMPTS) continue; // stop retrying a deterministic failure; visible in the lifecycle row
    if (row.disposition && row.disposition !== "exec-succeeded") {
      decisions.push({ jobId: job.jobId, reason: "dispatch_failed" });
      continue;
    }
    if (row.disposition === "exec-succeeded") {
      decisions.push({ jobId: job.jobId, reason: "runner_gone" });
      continue;
    }
    const anchor = row.containerStartedAt ?? row.dispatchRequestedAt;
    if (nowMs - Date.parse(anchor) >= STALE_DISPATCH_MS) decisions.push({ jobId: job.jobId, reason: "dispatch_stale" });
  }
  return decisions;
}

/** Classifies a sandbox.exec failure so capacity is distinguishable from a runner that ran and failed. */
export function classifyStartError(message: string): RunnerDisposition {
  const m = message.toLowerCase();
  if (/capacity|max_instances|max instances|too many|no available|limit/.test(m)) return "capacity";
  if (/timeout|timed out/.test(m)) return "exec-timeout";
  return "start-failed";
}
