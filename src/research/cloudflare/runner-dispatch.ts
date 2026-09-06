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

export function isPinned(labels: readonly string[]): boolean {
  return labels.some((l) => l.startsWith(PINNED_LABEL_PREFIX));
}

/** Ours: a pinned job (runs-on [self-hosted, "diffci-job-<run id>"]) or a legacy plain-label job
 * (runs-on [self-hosted, cloudflare]). Everything else is GitHub-hosted or another fleet. */
export function jobAddressedToFleet(labels: readonly string[]): boolean {
  if (!labels.includes("self-hosted")) return false;
  return isPinned(labels) || CLAIM_LABELS.every((l) => labels.includes(l));
}

/**
 * The labels the runner registers with: EXACTLY the job's own required labels (minus `self-hosted`
 * and the OS/arch labels, which the runner adds itself). GitHub assigns a runner any queued job whose
 * required labels are a subset of the runner's, oldest first, so eligibility is decided by what the
 * WORKFLOW requires:
 *   - a job whose workflow requires only [self-hosted, "diffci-job-<run id>"] gets a pin-only runner,
 *     which qualifies for exactly that job and can never be handed a legacy job (which requires
 *     `cloudflare`);
 *   - a job whose workflow still requires `cloudflare` as well (commits before the pin-only workflow)
 *     needs a runner with both, and that runner remains eligible for legacy jobs - a transition-only
 *     hazard the reconciler's `runner_gone` rule recovers from;
 *   - a legacy plain-label job's runner registers with `cloudflare` and takes GitHub's oldest plain job.
 * Registering FEWER labels than the job requires strands the job: the 07:43Z re-dispatches registered
 * pin-only runners for jobs that still required `cloudflare`, and both sat idle while the jobs stayed
 * queued.
 */
export function registrationLabels(labels: readonly string[]): string[] {
  const custom = labels.filter((l) => !IMPLICIT_LABELS.has(l));
  return custom.length > 0 ? custom : ["cloudflare"];
}

const IMPLICIT_LABELS = new Set(["self-hosted", "linux", "Linux", "x64", "X64"]);

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

// ---------------------------------------------------------------------------------------------------
// Batch consumption (2026-09-06). A push produces several jobs within a second of each other (CI plus
// observation); with one message per invocation and Cloudflare scaling consumer concurrency up only
// gradually, the second job used to wait behind the first's whole runner lifecycle (~3 minutes,
// research note Fix 4 observations). The queue now groups messages arriving within a short window
// into one batch, and this consumes a batch's messages concurrently - each message keeps its own
// ack/retry, so one job's failure never decides another's fate.
// ---------------------------------------------------------------------------------------------------

export interface DispatchQueueMessage {
  body: unknown;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface BatchOutcome {
  dispatched: number;
  retried: number;
  malformed: number;
}

export const DISPATCH_RETRY_DELAY_SECONDS = 90;

export async function consumeDispatchBatch(
  messages: readonly DispatchQueueMessage[],
  dispatch: (message: DispatchMessage) => Promise<void>,
  log: (message: string) => void = () => {},
  retryDelaySeconds: number = DISPATCH_RETRY_DELAY_SECONDS,
): Promise<BatchOutcome> {
  const outcome: BatchOutcome = { dispatched: 0, retried: 0, malformed: 0 };
  await Promise.all(
    messages.map(async (message) => {
      const parsed = parseDispatchMessage(message.body);
      if (!parsed) {
        log(`github-runner: malformed dispatch message acked: ${JSON.stringify(message.body).slice(0, 300)}`);
        outcome.malformed += 1;
        message.ack();
        return;
      }
      try {
        await dispatch(parsed);
        outcome.dispatched += 1;
        message.ack();
      } catch (error: unknown) {
        log(`github-runner: dispatch for job ${parsed.jobId} will retry: ${error instanceof Error ? error.message : String(error)}`);
        outcome.retried += 1;
        message.retry({ delaySeconds: retryDelaySeconds });
      }
    }),
  );
  if (messages.length > 1) log(`github-runner: batch of ${messages.length} dispatched concurrently: ${JSON.stringify(outcome)}`);
  return outcome;
}
