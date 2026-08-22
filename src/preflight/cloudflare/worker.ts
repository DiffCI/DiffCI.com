/**
 * Live prospective Shadow Preflight Worker (Preflight P1 Part M). Runs on a cron trigger (matching
 * Stage 2F's own established polling cadence - see the "Autonomous shadow cron" memory note), NOT a
 * GitHub webhook - deliberately: diffci-github-runner already owns the one webhook URL a GitHub App
 * can have, and this Worker's whole point is to stay structurally separate from that production path
 * (Part D's own rationale, extended here to the runtime, not just storage). Reuses the SAME GitHub App
 * (src/shadow/github-app.ts, read-only import - never modified) already installed and working for the
 * runner, just for its own read-only API calls.
 *
 * Each tick, in this exact order (the order IS the "prediction before ground truth" enforcement):
 *  1. For each enrolled repository (preflight_repositories - DiffCI.com only, Part M's explicit scope),
 *     list recent commits on the default branch.
 *  2. For each commit with no existing prediction, build one from ONLY that commit's own diff/tree
 *     state (runtime-parity + risk-model v1 + planner) and persist it via createLivePrediction() -
 *     which itself refuses if ground truth is somehow already known, a second, structural safety net.
 *  3. ONLY AFTER that, separately, for predictions still lacking a reconciliation, check whether their
 *     commit's real workflow run has completed; if so, fetch failing-step evidence and reconcile.
 *
 * Advisory only (Part J) - this Worker never touches GitHub check-runs, statuses, or the workflow
 * itself. It reads; it never writes back to CI.
 */
import { makeD1PredictionStore, type D1Binding } from "./d1-prediction-store.js";
import { evaluateRuntimeParity, extractPackageJsonEngineSource, extractDockerfileNodeSetupSource } from "../runtime-parity.js";
import { computeFailureRiskScore } from "../risk-model.js";
import { planPreflightChecks } from "../planner.js";
import { classifyFailureFromEvidence } from "../fingerprint.js";
import { reconcile, type ReconciliationRecord } from "../reconciliation.js";
import type { FailureClass } from "../taxonomy.js";
import type { PredictionRecord } from "../prediction-store.js";

interface ExecutionCtx {
  waitUntil(promise: Promise<unknown>): void;
}

interface ServiceBinding {
  fetch(request: Request): Promise<Response>;
}

interface Env {
  PREFLIGHT_DB: D1Binding;
  // No GitHub App credentials of its own, deliberately - see getInstallationToken() below.
  RUNNER_WORKER: ServiceBinding;
  RUNNER_WORKER_TOKEN: string;
  PREFLIGHT_DISPATCH_TOKEN?: string;
}

/** Requests a real installation token from diffci-github-runner's /installation-token route
 * (src/research/cloudflare/github-runner-worker.ts) via a Cloudflare Service Binding - an in-process
 * Worker-to-Worker call, never a public fetch() to that Worker's own workers.dev URL (Cloudflare
 * rejects that specific pattern with error 1042 - confirmed live). This Worker holds no second copy
 * of the GitHub App's private key: one Worker owns the credential, every other internal caller
 * borrows a short-lived token from it. Only the URL's path+query matter to a service-bound fetch - the
 * host below is a placeholder, never actually resolved over the network. */
async function getInstallationToken(env: Env, installationId: string): Promise<string> {
  const res = await env.RUNNER_WORKER.fetch(
    new Request(`https://internal/installation-token?installationId=${installationId}`, { headers: { Authorization: `Bearer ${env.RUNNER_WORKER_TOKEN}` } }),
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`installation-token service-binding request failed (${res.status}) body=${text.slice(0, 300)}`);
  }
  const body = (await res.json()) as { ok: boolean; token?: string; error?: string };
  if (!body.ok || !body.token) throw new Error(`installation-token proxy returned no token: ${body.error ?? "unknown error"}`);
  return body.token;
}

const DOCKERFILE_PATH = "ops/github-runner/Dockerfile";
const ALGORITHM_VERSION = "preflight-p1-v1";
const EVIDENCE_VERSION = "p1-github-api-v1";

interface EnrolledRepo {
  repository_owner_name: string;
  observation_start_at: string;
  enabled: number;
  installation_id: string;
}

async function ghFetch(token: string, url: string): Promise<Response> {
  return fetch(url, { headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json", "User-Agent": "diffci-preflight" } });
}

async function generatePredictionForCommit(db: D1Binding, token: string, owner: string, repo: string, sha: string): Promise<PredictionRecord | undefined> {
  const store = makeD1PredictionStore(db);
  const existing = await db.prepare(`SELECT 1 FROM preflight_predictions WHERE repository_owner_name = ? AND commit_sha = ?`).bind(`${owner}/${repo}`, sha).first();
  if (existing) return undefined; // already predicted - never re-predict the same commit

  const commitRes = await ghFetch(token, `https://api.github.com/repos/${owner}/${repo}/commits/${sha}`);
  if (!commitRes.ok) return undefined;
  const commitBody = (await commitRes.json()) as { files?: Array<{ filename: string }> };
  const changedFiles = (commitBody.files ?? []).map((f) => f.filename);

  const [pkgRes, dockerRes] = await Promise.all([
    ghFetch(token, `https://api.github.com/repos/${owner}/${repo}/contents/package.json?ref=${sha}`),
    ghFetch(token, `https://api.github.com/repos/${owner}/${repo}/contents/${DOCKERFILE_PATH}?ref=${sha}`),
  ]);
  const pkgText = pkgRes.ok ? decodeGithubContent(await pkgRes.json()) : undefined;
  const dockerText = dockerRes.ok ? decodeGithubContent(await dockerRes.json()) : undefined;

  const sources = [pkgText ? extractPackageJsonEngineSource(pkgText) : undefined, dockerText ? extractDockerfileNodeSetupSource(dockerText, DOCKERFILE_PATH) : undefined].filter(
    (s): s is NonNullable<typeof s> => Boolean(s),
  );
  const parity = evaluateRuntimeParity("node", sources);

  const isDockerfileChange = changedFiles.some((f) => f.includes(DOCKERFILE_PATH));
  const isCiWorkflowChange = changedFiles.some((f) => f.includes(".github/workflows/"));
  const isDependencyManifestChange = changedFiles.some((f) => /package(-lock)?\.json$|yarn\.lock$|pnpm-lock\.yaml$/.test(f));
  const isConfigOrGlobalChange = changedFiles.some((f) => /wrangler\.|tsconfig\.json$|\.env$/.test(f));
  const isRuntimeRequirementChange = changedFiles.some((f) => f === "package.json" || f === ".nvmrc");

  const risk = computeFailureRiskScore({
    changedFileTypes: [...new Set(changedFiles.map((f) => (f.includes(".") ? "." + f.split(".").pop() : "")))].filter(Boolean),
    dependencyFanOut: 0,
    affectedTestCount: 1,
    matchesKnownFailureFingerprint: false,
    isConfigOrGlobalChange,
    isDependencyManifestChange,
    isMigrationOrSchemaChange: false,
    isGeneratedCodeChange: false,
    runtimeParityVerdict: parity.verdict,
    isRuntimeRequirementChange,
    isDockerfileChange,
    isCiWorkflowChange,
  });

  const plan = planPreflightChecks(changedFiles);
  const recommendedChecks = plan.checks.map((c) => c.check.id);
  const predictedFailureClasses: FailureClass[] = [];
  if (parity.verdict === "CONFLICTING" || parity.verdict === "INCOMPATIBLE" || parity.verdict === "MAJOR_MISMATCH") predictedFailureClasses.push("CONFIGURATION");

  return store.createLivePrediction({
    repositoryOwnerName: `${owner}/${repo}`,
    commitSha: sha,
    changedFiles,
    riskScore: risk.failureRiskScore,
    riskReasons: risk.riskReasons,
    recommendedChecks,
    predictedFailureClasses,
    expectedEarlyDetectionStrategy: predictedFailureClasses.length > 0 ? `runtime_parity (verdict ${parity.verdict}) is expected to surface this before full CI runs` : "no elevated-risk signal identified for this commit by the current algorithm",
    evidenceVersion: EVIDENCE_VERSION,
    algorithmVersion: ALGORITHM_VERSION,
  });
}

function decodeGithubContent(body: unknown): string | undefined {
  const b = body as { content?: string; encoding?: string };
  if (!b?.content || b.encoding !== "base64") return undefined;
  return atob(b.content.replace(/\n/g, ""));
}

async function reconcilePendingPredictions(db: D1Binding, token: string, owner: string, repo: string): Promise<number> {
  const { results: pending } = await db
    .prepare(
      `SELECT p.* FROM preflight_predictions p LEFT JOIN preflight_reconciliations r ON r.prediction_id = p.id WHERE p.repository_owner_name = ? AND r.id IS NULL`,
    )
    .bind(`${owner}/${repo}`)
    .all<Record<string, unknown>>();

  let reconciledCount = 0;
  for (const row of pending) {
    const sha = row.commit_sha as string;
    const runsRes = await ghFetch(token, `https://api.github.com/repos/${owner}/${repo}/actions/runs?head_sha=${sha}&per_page=5`);
    if (!runsRes.ok) continue;
    const runsBody = (await runsRes.json()) as { workflow_runs?: Array<{ id: number; status: string; conclusion: string | null; run_started_at: string; updated_at: string }> };
    const run = (runsBody.workflow_runs ?? []).find((r) => r.status === "completed");
    if (!run) continue; // still running or hasn't started - check again next tick, never guess

    let actualFailureClass: FailureClass | undefined;
    let actualErrorFingerprint: string | undefined;
    let failingJob: string | undefined;
    const totalWorkflowDurationMs = Math.max(0, new Date(run.updated_at).getTime() - new Date(run.run_started_at).getTime());

    if (run.conclusion !== "success") {
      const jobsRes = await ghFetch(token, `https://api.github.com/repos/${owner}/${repo}/actions/runs/${run.id}/jobs`);
      if (jobsRes.ok) {
        const jobsBody = (await jobsRes.json()) as { jobs?: Array<{ id: number; name: string; conclusion: string | null; steps?: Array<{ name: string; conclusion: string | null }> }> };
        const failedJob = (jobsBody.jobs ?? []).find((j) => j.conclusion === "failure");
        if (failedJob) {
          failingJob = failedJob.name;
          const failedStep = failedJob.steps?.find((s) => s.conclusion === "failure");
          const logsRes = await ghFetch(token, `https://api.github.com/repos/${owner}/${repo}/actions/jobs/${failedJob.id}/logs`);
          const logText = logsRes.ok ? (await logsRes.text()).slice(-8000) : "";
          actualFailureClass = classifyFailureFromEvidence({ jobName: failedJob.name, stepName: failedStep?.name, errorText: logText });
          actualErrorFingerprint = `${actualFailureClass}|${failedJob.name}|${(failedStep?.name ?? "").slice(0, 60)}`;
        }
      }
    }

    const predictionRow = row as unknown as { id: string; predicted_failure_classes_json: string; recommended_checks_json: string };
    const record: ReconciliationRecord = reconcile({
      prediction: { id: predictionRow.id, predictedFailureClasses: JSON.parse(predictionRow.predicted_failure_classes_json), recommendedChecks: JSON.parse(predictionRow.recommended_checks_json) },
      workflowRunId: String(run.id),
      workflowConclusion: run.conclusion ?? "unknown",
      actualFailureClass,
      actualErrorFingerprint,
      failingJob,
      totalWorkflowDurationMs,
    });

    await db
      .prepare(
        `INSERT INTO preflight_reconciliations (id, prediction_id, reconciled_at, workflow_run_id, workflow_conclusion, actual_failure_class, actual_error_fingerprint, failing_job, failing_test, time_to_failure_ms, total_workflow_duration_ms, outcome, outcome_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        record.predictionId,
        record.reconciledAt,
        record.workflowRunId,
        record.workflowConclusion,
        record.actualFailureClass ?? null,
        record.actualErrorFingerprint ?? null,
        record.failingJob ?? null,
        record.failingTest ?? null,
        record.timeToFailureMs ?? null,
        record.totalWorkflowDurationMs,
        record.outcome,
        record.outcomeReason,
      )
      .run();
    reconciledCount++;
  }
  return reconciledCount;
}

async function runTick(env: Env): Promise<{ repositoriesProcessed: number; predictionsCreated: number; reconciled: number }> {
  const { results: repos } = await env.PREFLIGHT_DB.prepare(`SELECT * FROM preflight_repositories WHERE enabled = 1`).bind().all<EnrolledRepo>();

  let predictionsCreated = 0;
  let reconciled = 0;
  for (const repo of repos) {
    const [owner, name] = repo.repository_owner_name.split("/");
    if (!owner || !name) continue;
    const token = await getInstallationToken(env, repo.installation_id);

    const commitsRes = await ghFetch(token, `https://api.github.com/repos/${owner}/${name}/commits?per_page=15`);
    if (commitsRes.ok) {
      const commits = (await commitsRes.json()) as Array<{ sha: string; commit: { committer: { date: string } } }>;
      // Only commits at/after this repo's own observation start - never predict for history that
      // predates enrollment (that would blur "prospective" with "retroactive").
      const eligible = commits.filter((c) => c.commit.committer.date >= repo.observation_start_at);
      console.log(`preflight: fetched ${commits.length} commits for ${owner}/${name}, ${eligible.length} eligible (observationStartAt=${repo.observation_start_at}, newest=${commits[0]?.commit.committer.date})`);
      for (const c of eligible) {
        const prediction = await generatePredictionForCommit(env.PREFLIGHT_DB, token, owner, name, c.sha);
        console.log(`preflight: generatePredictionForCommit(${c.sha.slice(0, 7)}) -> ${prediction ? "created " + prediction.id : "skipped (already predicted or no data)"}`);
        if (prediction) predictionsCreated++;
      }
    } else {
      console.log(`preflight: commits fetch failed (${commitsRes.status}) for ${owner}/${name}`);
    }

    reconciled += await reconcilePendingPredictions(env.PREFLIGHT_DB, token, owner, name);
  }

  return { repositoriesProcessed: repos.length, predictionsCreated, reconciled };
}

export default {
  async scheduled(_event: unknown, env: Env, ctx: ExecutionCtx): Promise<void> {
    ctx.waitUntil(
      runTick(env)
        .then((r) => console.log("preflight tick:", JSON.stringify(r)))
        .catch((err) => console.log("preflight tick failed:", String(err))),
    );
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const auth = request.headers.get("Authorization") ?? "";
    if (!env.PREFLIGHT_DISPATCH_TOKEN || auth !== `Bearer ${env.PREFLIGHT_DISPATCH_TOKEN}`) return new Response("unauthorized", { status: 401 });

    if (url.pathname === "/run-once" && request.method === "POST") {
      const result = await runTick(env);
      return Response.json({ ok: true, ...result });
    }
    if (url.pathname === "/status" && request.method === "GET") {
      const { results: repos } = await env.PREFLIGHT_DB.prepare(`SELECT * FROM preflight_repositories`).bind().all();
      const { results: predictions } = await env.PREFLIGHT_DB.prepare(`SELECT COUNT(*) as count FROM preflight_predictions`).bind().all<{ count: number }>();
      const { results: reconciliations } = await env.PREFLIGHT_DB.prepare(`SELECT outcome, COUNT(*) as count FROM preflight_reconciliations GROUP BY outcome`).bind().all();
      return Response.json({ ok: true, repos, totalPredictions: predictions[0]?.count ?? 0, outcomeCounts: reconciliations });
    }
    return new Response("not found", { status: 404 });
  },
};
