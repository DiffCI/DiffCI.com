/**
 * Stage 0 cloud validation Worker. Deployed via wrangler.research-sandbox.jsonc - see
 * diffci/docs/research/2026-08-20-stage0-full-experiment-architecture.md for why the actual
 * clone+analyze step has to run in a Cloudflare Container (the Sandbox SDK) rather than directly in
 * this Worker: plain Workers have no filesystem/subprocess capability, so git clone and the
 * TypeScript compiler API can't run here at all.
 *
 * Uses the PUBLIC pre-built docker.io/cloudflare/sandbox:0.12.5 image (no local Docker build needed -
 * Cloudflare pulls public Docker Hub images server-side) rather than a custom Dockerfile, because no
 * local Docker daemon was available to build one. The diffci source is instead uploaded into the
 * running container at request time as a tarball (POST /v1/validate, multipart "source" field) and
 * extracted + npm-installed on first use - the same pattern ops/cloudflare-builder already uses for
 * this app's own source, just applied to an ad-hoc per-request payload instead of a baked-in image.
 * See Dockerfile.research-sandbox for the leaner alternative once a real Docker build is available.
 *
 * This is the ONE-repository cloud validation step, not the full 20-repo/2000-delta orchestrator.
 */
import { getSandbox } from "@cloudflare/sandbox";
import { R2EvidenceStore, type R2Binding } from "./r2-store.js";
import { withContainerRetry } from "./retry.js";
import { buildSandboxSessionId } from "./session-id.js";
import { batchDeltas, persistBatchResults, planResumableWork, type DeltaCandidate, type PersistableResult } from "./resumable-batch.js";
import { computeExperimentProgress, planOrchestratorDispatch, type CorpusEntry, type RepositoryState } from "./orchestrator-plan.js";
import { evaluateBudgetStatus } from "../config/cost-model.js";
import { makeD1ShadowStore, type ObservationSource } from "./shadow-store.js";
import { reconcilePrediction } from "../../shadow/reconcile.js";
import { computeLogicalEventKey } from "../../shadow/event-identity.js";
import { DEFAULT_SHADOW_CRON_CONFIG, runShadowCronOnce, type PollableRepository, type ShadowCronDeps, type VerifiedSourceArchive } from "./shadow-cron.js";
import { handleShadowWebhook } from "./shadow-webhook.js";
import { exchangeInstallationToken, signAppJwt, verifyWebhookSignature } from "../../shadow/github-app.js";
import { computeSourceIntegrity, isValidSha, type SourceArchiveMeta } from "./shadow-source-integrity.js";
// External Shadow Pilot M1 (2026-08-25). makeD1ShadowReadBoundary is nominally the product layer's
// read-only view onto this Worker's own database; reused here rather than duplicated because every
// method on it is a SELECT, so running it in-process against RESEARCH_DB is strictly narrower than the
// direct access this Worker already has. The two D1Binding types are structurally identical, declared
// separately per module to keep each module dependency-free - hence the casts at the call site.
import { makeD1ShadowReadBoundary, type D1Binding as ShadowBoundaryD1 } from "../../product/shadow-read-boundary.js";
import { makeD1ShadowEconomicsStore, type D1Binding as ShadowEconomicsD1 } from "../../usage/shadow-economics-store.js";
import { runShadowEconomicsCaptureSweep } from "../../usage/shadow-economics-job.js";
import { runShadowEconomicsRecompute } from "../../usage/shadow-economics-recompute.js";

// standard-2 Sandbox instance type (wrangler.research-sandbox.jsonc): 1 vCPU, 6 GiB memory, 12 GB disk.
// Real Container CPU billing is active-use-only, but wall-clock is used as a conservative (over-, not
// under-) proxy since there's no readback API for actual CPU utilization from inside a Worker. Memory
// and disk billing is on PROVISIONED capacity for the whole active duration (Cloudflare's own pricing
// note: "Memory cost and disk pricing remain unchanged, and is still calculated based on provisioned
// resources" - unlike CPU, which moved to active-use billing in the 2025-11-21 pricing change).
const SANDBOX_VCPUS = 1;
const SANDBOX_MEMORY_GIB = 6;
const SANDBOX_DISK_GB = 12;

export { Sandbox as ResearchSandbox } from "@cloudflare/sandbox";

const MAX_SOURCE_ARCHIVE_BYTES = 50 * 1024 * 1024; // diffci source, no node_modules: well under this

interface D1Binding {
  prepare(query: string): {
    bind(...values: unknown[]): {
      run(): Promise<{ meta?: { changes?: number } }>;
      all<T = unknown>(): Promise<{ results: T[] }>;
      first<T = unknown>(): Promise<T | null>;
    };
  };
}

interface ValidationEnv {
  ResearchSandbox: unknown;
  RESEARCH_BUCKET: R2Binding;
  RESEARCH_DB: D1Binding;
  DIFFCI_RESEARCH_ENABLED: string;
  /** Gates the scheduled() autonomous shadow-poll handler independently of the HTTP API, so the cron
   * can be switched off (config redeploy) without disabling manually-driven research calls. */
  SHADOW_CRON_ENABLED?: string;
  RESEARCH_DISPATCH_TOKEN?: string;
  /** The registered DiffCI Shadow GitHub App (docs/github-app-registration.md) - all three optional
   * Worker secrets. Webhook route returns 503 until the webhook secret exists; installation-token
   * minting silently falls back to GITHUB_TOKEN until app id + private key exist. */
  SHADOW_GITHUB_APP_ID?: string;
  SHADOW_GITHUB_APP_PRIVATE_KEY?: string;
  SHADOW_GITHUB_WEBHOOK_SECRET?: string;
  /** The git commit SHA this exact Worker deployment expects its shadow source archive to be built
   * from - stamped at deploy time via `wrangler deploy --var EXPECTED_SOURCE_SHA:<HEAD>`
   * (scripts/deploy-research-sandbox.ts), deliberately NOT a static value in wrangler.research-
   * sandbox.jsonc (a checked-in SHA would go stale the moment of the next commit, recreating the exact
   * footgun this exists to close). Unset means "this Worker was deployed without the canonical deploy
   * script" - autonomous polling refuses to run rather than trusting an unverifiable archive; see
   * shadow-source-integrity.ts. */
  EXPECTED_SOURCE_SHA?: string;
  /** Optional Worker secret (wrangler secret put GITHUB_TOKEN). When present, forwarded into the
   * container's exec env (never as a CLI arg - see cloudflare-analyze-batch.ts) to enable authenticated
   * historical CI evidence collection (4500 GitHub REST calls/hour vs 50 unauthenticated). Absent by
   * default; historical evidence collection is simply off when unset, exactly as the medium batch and
   * local pilot handled it - never blocks or fails the run. */
  GITHUB_TOKEN?: string;
}

interface ValidationSummary {
  owner: string;
  name: string;
  durationMs: number;
  commitsSampled: number;
  recordsAnalyzed: number;
  resumedFromExisting: number;
  errors: string[];
  metadata: { commitCount: number; sourceFiles: number; workflowFiles: number; localPath: string };
  records: Array<{
    identity: { logicalDeltaKey: string; baseSha: string; headSha: string };
    fallback: boolean;
    graphConfidence: string;
    testsTotal: number;
    testsSelectedByPath: number;
    testsSelectedByDiffci: number;
  }>;
  repoResultSummary: { commitsAnalyzed: number; fallbackRate: number; medianTaskReduction: number; diffciIncrementalAdvantage: number };
  stage0SummaryExcerpt: Record<string, number>;
}

function json(payload: unknown, status = 200): Response {
  return Response.json(payload, { status, headers: { "Cache-Control": "no-store" } });
}

function errorTail(result: { stdout?: string; stderr?: string } | undefined): string {
  return [result?.stdout, result?.stderr].filter(Boolean).join("\n").slice(-8_000);
}

async function secureTokenEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i]! ^ bb[i]!;
  return diff === 0;
}

async function authorized(request: Request, expected?: string): Promise<boolean> {
  if (!expected) return false;
  const auth = request.headers.get("Authorization") || "";
  const actual = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!actual) return false;
  return secureTokenEqual(actual, expected);
}

// Retry policy (transient container-lifecycle failures) lives in retry.ts, kept dependency-free from
// @cloudflare/sandbox so it's unit-testable in plain Node - see tests/research/cloudflare/retry.test.ts.

async function prepareContainer(sandbox: any, sourceTarball: File): Promise<void> {
  await sandbox.exec("rm -rf /opt/diffci /workspace && mkdir -p /opt/diffci /workspace", { timeout: 30_000 });
  await sandbox.writeFile("/opt/diffci-source.tgz", sourceTarball.stream());
  const extract = await sandbox.exec("tar -xzf /opt/diffci-source.tgz -C /opt/diffci", { timeout: 60_000 });
  if (!extract.success) throw new Error(`source-extraction-failed: ${errorTail(extract)}`);

  // The public sandbox image is documented to ship git + Node + npm, but verify rather than assume -
  // and self-heal with apt/apk if a variant is missing one, so this isn't silently broken by an image
  // update. Failing loudly here (rather than deep inside the analysis) makes the real cause obvious.
  const toolCheck = await sandbox.exec("git --version && node --version && npm --version", { timeout: 15_000 });
  if (!toolCheck.success) {
    const install = await sandbox.exec(
      "(command -v apt-get >/dev/null && apt-get update && apt-get install -y git) || (command -v apk >/dev/null && apk add --no-cache git) || true",
      { timeout: 60_000 },
    );
    const recheck = await sandbox.exec("git --version && node --version && npm --version", { timeout: 15_000 });
    if (!recheck.success) {
      throw new Error(`base image missing git/node/npm and self-heal failed: ${errorTail(install)} / ${errorTail(recheck)}`);
    }
  }

  const install = await sandbox.exec("cd /opt/diffci && npm ci", { timeout: 120_000 });
  if (!install.success) throw new Error(`npm-ci-failed: ${errorTail(install)}`);
}

// owner/name/language get interpolated directly into a shell command below (sandbox.exec() runs
// through a shell). Bearer-token auth limits exposure to authorized callers, but that's not a reason to
// skip validation - reject anything outside GitHub's actual username/repo character set before it ever
// reaches a shell command, rather than relying on the auth gate alone.
const GITHUB_OWNER_OR_NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const LANGUAGE_PATTERN = /^[a-z]{1,20}$/;

function validateShellSafeIdentifiers(owner: string, name: string, language: string): void {
  if (!GITHUB_OWNER_OR_NAME_PATTERN.test(owner)) throw new Error(`invalid owner: "${owner}"`);
  if (!GITHUB_OWNER_OR_NAME_PATTERN.test(name)) throw new Error(`invalid name: "${name}"`);
  if (!LANGUAGE_PATTERN.test(language)) throw new Error(`invalid language: "${language}"`);
}

async function runOnce(sandbox: any, owner: string, name: string, language: string, commits: number): Promise<ValidationSummary> {
  validateShellSafeIdentifiers(owner, name, language);
  const exec = await sandbox.exec(
    `cd /opt/diffci && npx tsx scripts/cloudflare-validation-run.ts --owner ${owner} --name ${name} --language ${language} --commits ${commits} --workspace /workspace`,
    { timeout: 240_000 },
  );
  if (!exec.success) {
    throw new Error(`validation script failed (exit ${exec.exitCode}): ${errorTail(exec)}`);
  }
  const file = await sandbox.readFile("/workspace/summary.json");
  return JSON.parse(String(file.content)) as ValidationSummary;
}

async function persistToR2(bucket: R2Binding, runId: string, label: "cold" | "warm", summary: ValidationSummary): Promise<string[]> {
  const store = new R2EvidenceStore(bucket);
  const keys: string[] = [];
  const summaryKey = `validation/${runId}/${label}-summary`;
  await store.put(summaryKey, summary);
  keys.push(summaryKey);
  for (const record of summary.records) {
    const key = `validation/${runId}/commits/${record.identity.logicalDeltaKey}`;
    await store.put(key, record);
    keys.push(key);
  }
  return keys;
}

async function persistToD1(db: D1Binding, runId: string, owner: string, name: string, summary: ValidationSummary): Promise<number> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO experiment_runs (experiment_id, diffci_version, schema_version, target_repositories, target_commit_deltas, created_at, status)
       VALUES (?, ?, ?, 1, ?, ?, 'COMPLETE')
       ON CONFLICT(experiment_id) DO UPDATE SET status = 'COMPLETE'`,
    )
    .bind(runId, "cloud-validation", "cloud-validation", summary.recordsAnalyzed, now)
    .run();

  await db
    .prepare(
      `INSERT INTO repository_runs (experiment_id, repository, status, commits_analyzed, started_at, completed_at)
       VALUES (?, ?, 'COMPLETE', ?, ?, ?)
       ON CONFLICT(experiment_id, repository) DO UPDATE SET status = 'COMPLETE', commits_analyzed = excluded.commits_analyzed, completed_at = excluded.completed_at`,
    )
    .bind(runId, `${owner}/${name}`, summary.recordsAnalyzed, now, now)
    .run();

  let inserted = 0;
  for (const record of summary.records) {
    await db
      .prepare(
        `INSERT INTO completed_deltas (logical_delta_key, experiment_id, repository, base_sha, head_sha, r2_evidence_key, fallback, graph_confidence, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(logical_delta_key) DO NOTHING`,
      )
      .bind(
        record.identity.logicalDeltaKey,
        runId,
        `${owner}/${name}`,
        record.identity.baseSha,
        record.identity.headSha,
        `validation/${runId}/commits/${record.identity.logicalDeltaKey}`,
        record.fallback ? 1 : 0,
        record.graphConfidence,
        now,
      )
      .run();
    inserted++;
  }
  return inserted;
}

interface AttemptResult {
  cold: ValidationSummary;
  warm: ValidationSummary;
  coldWallMs: number;
  warmWallMs: number;
}

async function attemptValidation(env: ValidationEnv, owner: string, name: string, language: string, commits: number, source: File, attempt: number): Promise<AttemptResult> {
  // A fresh session id per attempt guarantees we never reconnect to the container that just died -
  // getSandbox() with a repeated id would otherwise risk resuming a Durable Object in an unknown state.
  // See session-id.ts for why this is a hash rather than a plain string join.
  const id = await buildSandboxSessionId(owner, name, attempt);
  const sandbox = getSandbox(env.ResearchSandbox as any, id, {
    enableDefaultSession: false,
    keepAlive: false,
    sleepAfter: "3m",
    transport: "rpc",
  });

  try {
    await prepareContainer(sandbox, source);

    const coldStart = Date.now();
    const cold = await runOnce(sandbox, owner, name, language, commits);
    const coldWallMs = Date.now() - coldStart;

    const warmStart = Date.now();
    const warm = await runOnce(sandbox, owner, name, language, commits);
    const warmWallMs = Date.now() - warmStart;

    await sandbox.destroy();
    return { cold, warm, coldWallMs, warmWallMs };
  } catch (error: unknown) {
    try {
      await sandbox.destroy();
    } catch {
      // best-effort cleanup - the sandbox may already be gone, which is exactly the failure mode.
    }
    throw error;
  }
}

async function validate(request: Request, env: ValidationEnv): Promise<Response> {
  const contentLength = Number(request.headers.get("Content-Length") || "0");
  if (contentLength > MAX_SOURCE_ARCHIVE_BYTES + 64 * 1024) {
    return json({ ok: false, error: "source-archive-too-large" }, 413);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, error: "multipart-form-required" }, 400);
  }
  const source = form.get("source");
  if (!(source instanceof File) || source.size < 1 || source.size > MAX_SOURCE_ARCHIVE_BYTES) {
    return json({ ok: false, error: "valid-source-archive-required" }, 400);
  }
  const owner = String(form.get("owner") || "");
  const name = String(form.get("name") || "");
  // Real finding, larger-study run 2026-08-20: this always ran the container script with the hardcoded
  // default "typescript" regardless of the real repository language, so every non-JS/TS corpus repo
  // reported the misleading "no tsconfig.json found" exclusion reason instead of the correct "does not
  // yet support <language>" one - see cloudflare-validation-run.ts's header comment. Now passed
  // through explicitly (still defaults to "typescript" for backward-compatible single-repo ad-hoc
  // calls that don't pass it).
  const language = String(form.get("language") || "typescript");
  const commits = Math.max(1, Math.min(10, Number.parseInt(String(form.get("commits") || "3"), 10) || 3));
  if (!owner || !name) return json({ ok: false, error: "owner and name required" }, 400);

  const runId = `${owner}-${name}-${Date.now()}`;

  try {
    const { result, attempts, retryReasons } = await withContainerRetry((attempt) => attemptValidation(env, owner, name, language, commits, source, attempt));
    const { cold, warm, coldWallMs, warmWallMs } = result;

    const r2ColdKeys = await persistToR2(env.RESEARCH_BUCKET, runId, "cold", cold);
    const r2WarmKeys = await persistToR2(env.RESEARCH_BUCKET, runId, "warm", warm);
    const d1Rows = await persistToD1(env.RESEARCH_DB, runId, owner, name, warm);

    if (retryReasons.length > 0) {
      console.log(`diffci-research-sandbox: ${owner}/${name} succeeded after ${attempts} attempt(s): ${retryReasons.join(" | ")}`);
    }

    return json({
      ok: true,
      runId,
      resumabilityProven: warm.resumedFromExisting === warm.recordsAnalyzed && warm.recordsAnalyzed > 0,
      reliability: { attempts, retried: retryReasons.length > 0, retryReasons },
      cold: { recordsAnalyzed: cold.recordsAnalyzed, resumedFromExisting: cold.resumedFromExisting, containerDurationMs: cold.durationMs, workerObservedWallMs: coldWallMs },
      warm: { recordsAnalyzed: warm.recordsAnalyzed, resumedFromExisting: warm.resumedFromExisting, containerDurationMs: warm.durationMs, workerObservedWallMs: warmWallMs },
      repoMetadata: warm.metadata,
      repoResultSummary: warm.repoResultSummary,
      stage0SummaryExcerpt: warm.stage0SummaryExcerpt,
      persistence: { r2ColdKeyCount: r2ColdKeys.length, r2WarmKeyCount: r2WarmKeys.length, d1RowsWritten: d1Rows },
      costTelemetry: {
        note: "workerObservedWallMs is an ESTIMATE (Worker-side wall clock around each exec call), not measured billed spend. Real billed Container CPU/memory/disk seconds must be reconciled afterward via the Cloudflare dashboard or GraphQL Analytics API - see cost-model.ts's measured-vs-estimated distinction. Does not include time spent on retried (failed) attempts.",
        estimatedTotalWallMs: coldWallMs + warmWallMs,
      },
    });
  } catch (error: unknown) {
    return json({ ok: false, owner, name, error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

// ============================================================================================
// Resumable per-repository run - the Stage 0 medium-batch orchestration endpoint (2026-08-21).
//
// Cross-container resumability was the explicit BLOCKING gate before spending medium-batch budget:
// "A container crash after delta N must not require recomputing deltas 1...N. A retry from another
// Sandbox/container instance must recognize previously completed work." The decision logic (what's
// already done, what's corrupt, what to persist) lives in resumable-batch.ts, tested in isolation
// against fake D1/R2 - this section only wires the REAL D1Binding/R2Binding to those interfaces and
// drives the actual two-phase container protocol: phase 1 clones+samples (cheap, no analysis), phase 2
// analyzes exactly the batches this Worker decided (after checking D1) still need real work. Each
// batch's results are persisted immediately, not buffered until the end, so a mid-run failure only
// loses the current in-flight batch - and because withContainerRetry re-runs the WHOLE attempt
// (including phase 1's D1 check) against a fresh container on any transient failure, "container B
// resumes container A's work" falls out of the existing retry mechanism for free, without a separate
// resume code path.
// ============================================================================================

interface RepoRunTelemetry {
  owner: string;
  name: string;
  excluded: boolean;
  exclusionReason?: string;
  candidateDeltas: number;
  resumedDeltas: number;
  invalidCheckpoints: number;
  newDeltasAnalyzed: number;
  duplicateDeltasPrevented: number;
  batchesRun: number;
  errors: string[];
  metadata: unknown;
  records: unknown[];
}

interface SampleResult {
  owner: string;
  name: string;
  metadata: { exclusionReason?: string; commitCount: number; sourceFiles: number; workflowFiles: number; localPath: string };
  candidates: DeltaCandidate[];
}

interface AnalyzeBatchResult {
  owner: string;
  name: string;
  durationMs: number;
  batchSize: number;
  records: Array<{
    identity: { logicalDeltaKey: string; baseSha: string; headSha: string };
    fallback: boolean;
    graphConfidence: string;
    testsTotal: number;
    testsSelectedByPath: number;
    testsSelectedByDiffci: number;
    [key: string]: unknown;
  }>;
  errors: string[];
}

async function execSampleCommits(sandbox: any, owner: string, name: string, language: string, maxCommits: number): Promise<SampleResult> {
  validateShellSafeIdentifiers(owner, name, language);
  const exec = await sandbox.exec(
    `cd /opt/diffci && npx tsx scripts/cloudflare-sample-commits.ts --owner ${owner} --name ${name} --language ${language} --max-commits ${maxCommits} --workspace /workspace`,
    { timeout: 120_000 },
  );
  if (!exec.success) throw new Error(`sample-commits failed (exit ${exec.exitCode}): ${errorTail(exec)}`);
  const file = await sandbox.readFile("/workspace/candidates.json");
  return JSON.parse(String(file.content)) as SampleResult;
}

async function execAnalyzeBatch(
  sandbox: any,
  owner: string,
  name: string,
  language: string,
  batch: { baseSha: string; headSha: string }[],
  batchIndex: number,
  githubToken?: string,
): Promise<AnalyzeBatchResult> {
  validateShellSafeIdentifiers(owner, name, language);
  const batchFilePath = `/workspace/batch-${batchIndex}.json`;
  await sandbox.writeFile(batchFilePath, JSON.stringify(batch));
  const outPath = `/workspace/batch-result-${batchIndex}.json`;
  const exec = await sandbox.exec(
    `cd /opt/diffci && npx tsx scripts/cloudflare-analyze-batch.ts --owner ${owner} --name ${name} --language ${language} --batch-file ${batchFilePath} --workspace /workspace --out ${outPath}`,
    // GITHUB_TOKEN is passed via exec's own env option, not interpolated into the command string above -
    // it never appears in the logged command or in errorTail() below. undefined is skipped per
    // BaseExecOptions ("Undefined values are skipped"), so this is a no-op when no token is configured.
    { timeout: 240_000, env: { GITHUB_TOKEN: githubToken } },
  );
  if (!exec.success) throw new Error(`analyze-batch failed (exit ${exec.exitCode}): ${errorTail(exec)}`);
  const file = await sandbox.readFile(outPath);
  return JSON.parse(String(file.content)) as AnalyzeBatchResult;
}

// ============================================================================================
// Stage 1A forensic support (2026-08-21) - targeted deep graph diagnostics against SPECIFIC known
// commits (not the deterministic sampler), for the UNSAFE-repository root-cause investigation. Reuses
// execSampleCommits purely to trigger the same proven clone step (a 1-commit sample is thrown away;
// the actual targets come from the caller's explicit batch), then runs the new forensic script which
// captures unresolved-import reasons, integrity findings, and node/edge counts that the Stage 0
// BenchmarkRecord schema discards. Read/analysis-only - writes nothing to D1/R2, touches no Stage 0
// evidence.

async function execForensicGraph(
  sandbox: any,
  owner: string,
  name: string,
  batch: { baseSha: string; headSha: string }[],
): Promise<{ owner: string; name: string; repoProfile: unknown; results: unknown[]; errors: string[] }> {
  const batchFilePath = `/workspace/forensic-batch.json`;
  await sandbox.writeFile(batchFilePath, JSON.stringify(batch));
  const outPath = `/workspace/forensic-result.json`;
  const exec = await sandbox.exec(
    `cd /opt/diffci && npx tsx scripts/cloudflare-forensic-graph.ts --owner ${owner} --name ${name} --batch-file ${batchFilePath} --workspace /workspace --out ${outPath}`,
    { timeout: 240_000 },
  );
  if (!exec.success) throw new Error(`forensic-graph failed (exit ${exec.exitCode}): ${errorTail(exec)}`);
  const file = await sandbox.readFile(outPath);
  return JSON.parse(String(file.content));
}

async function forensicDiagnose(request: Request, env: ValidationEnv): Promise<Response> {
  const contentLength = Number(request.headers.get("Content-Length") || "0");
  if (contentLength > MAX_SOURCE_ARCHIVE_BYTES + 64 * 1024) {
    return json({ ok: false, error: "source-archive-too-large" }, 413);
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, error: "multipart-form-required" }, 400);
  }
  const source = form.get("source");
  if (!(source instanceof File) || source.size < 1 || source.size > MAX_SOURCE_ARCHIVE_BYTES) {
    return json({ ok: false, error: "valid-source-archive-required" }, 400);
  }
  const owner = String(form.get("owner") || "");
  const name = String(form.get("name") || "");
  const language = String(form.get("language") || "typescript");
  const deltasRaw = String(form.get("deltas") || "[]");
  let deltas: { baseSha: string; headSha: string }[];
  try {
    deltas = JSON.parse(deltasRaw);
  } catch {
    return json({ ok: false, error: "deltas must be a JSON array" }, 400);
  }
  if (!owner || !name) return json({ ok: false, error: "owner and name required" }, 400);
  if (!Array.isArray(deltas) || deltas.length === 0 || deltas.length > 25) {
    return json({ ok: false, error: "deltas must be a 1-25 element array of {baseSha,headSha}" }, 400);
  }
  validateShellSafeIdentifiers(owner, name, language);

  const id = await buildSandboxSessionId(owner, name, 1);
  const sandbox = getSandbox(env.ResearchSandbox as any, `${id}-forensic`, { enableDefaultSession: false, keepAlive: false, sleepAfter: "5m", transport: "rpc" });
  try {
    await prepareContainer(sandbox, source);
    // Throwaway 1-commit sample purely to trigger the proven clone/update step at the same repo path
    // convention the forensic script expects (see repoLocalPath in collector.ts) - the actual targets
    // come from `deltas` below, not from this sample.
    await execSampleCommits(sandbox, owner, name, language, 1);
    const result = await execForensicGraph(sandbox, owner, name, deltas);
    await sandbox.destroy();
    return json({ ok: true, ...result });
  } catch (error: unknown) {
    try { await sandbox.destroy(); } catch { /* best-effort cleanup */ }
    return json({ ok: false, owner, name, error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

// ============================================================================================
// Stage 1B runtime experiment PILOT (2026-08-21) - real wall-clock test-EXECUTION timing (FULL/PATH/
// DiffCI) for one already-cloned delta. See scripts/cloudflare-runtime-benchmark.ts's own doc comment
// for full scope/caveats (pilot, not a broad multi-repo/multi-runner harness; Cloudflare Containers, not
// real GitHub Actions runners - a genuine, stated environmental difference). Real test execution needs
// the actual working tree checked out, unlike pure analysis - see the script's own git-checkout step.

async function execRuntimeBenchmark(
  sandbox: any,
  owner: string,
  name: string,
  baseSha: string,
  headSha: string,
  repetitions: number,
): Promise<unknown> {
  const outPath = `/workspace/runtime-result.json`;
  const exec = await sandbox.exec(
    `cd /opt/diffci && npx tsx scripts/cloudflare-runtime-benchmark.ts --owner ${owner} --name ${name} --base-sha ${baseSha} --head-sha ${headSha} --workspace /workspace --repetitions ${repetitions} --out ${outPath}`,
    { timeout: 300_000 },
  );
  if (!exec.success) throw new Error(`runtime-benchmark failed (exit ${exec.exitCode}): ${errorTail(exec)}`);
  const file = await sandbox.readFile(outPath);
  return JSON.parse(String(file.content));
}

async function runtimeBenchmark(request: Request, env: ValidationEnv): Promise<Response> {
  const contentLength = Number(request.headers.get("Content-Length") || "0");
  if (contentLength > MAX_SOURCE_ARCHIVE_BYTES + 64 * 1024) {
    return json({ ok: false, error: "source-archive-too-large" }, 413);
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, error: "multipart-form-required" }, 400);
  }
  const source = form.get("source");
  if (!(source instanceof File) || source.size < 1 || source.size > MAX_SOURCE_ARCHIVE_BYTES) {
    return json({ ok: false, error: "valid-source-archive-required" }, 400);
  }
  const owner = String(form.get("owner") || "");
  const name = String(form.get("name") || "");
  const language = String(form.get("language") || "typescript");
  const baseSha = String(form.get("baseSha") || "");
  const headSha = String(form.get("headSha") || "");
  const repetitions = Math.max(1, Math.min(5, Number.parseInt(String(form.get("repetitions") || "3"), 10) || 3));
  if (!owner || !name || !baseSha || !headSha) return json({ ok: false, error: "owner, name, baseSha, headSha required" }, 400);
  validateShellSafeIdentifiers(owner, name, language);

  const id = await buildSandboxSessionId(owner, name, 1);
  const sandbox = getSandbox(env.ResearchSandbox as any, `${id}-runtime`, { enableDefaultSession: false, keepAlive: false, sleepAfter: "5m", transport: "rpc" });
  try {
    await prepareContainer(sandbox, source);
    await execSampleCommits(sandbox, owner, name, language, 1);
    const result = await execRuntimeBenchmark(sandbox, owner, name, baseSha, headSha, repetitions);
    await sandbox.destroy();
    return json({ ok: true, ...(result as object) });
  } catch (error: unknown) {
    try { await sandbox.destroy(); } catch { /* best-effort cleanup */ }
    return json({ ok: false, owner, name, error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

// ============================================================================================
// Stage 2 Gate A (2026-08-21) - the Cloudflare-poll shadow-observation source. See
// docs/research/2026-08-21-stage2-architecture.md for why polling rather than a GitHub App/webhook: no
// App is registered yet, and this account's own GitHub Actions is currently billing-blocked, so this
// deliberately does not depend on DentalPresence.in's own CI - it targets a real third-party repository
// whose CI is unaffected. execShadowPoll clones/updates the target itself (unlike execRuntimeBenchmark,
// which relies on execSampleCommits for its throwaway clone trigger) - see cloudflare-shadow-poll.ts.

async function execShadowPoll(sandbox: any, owner: string, name: string, language: string, lastSeenSha: string | undefined, cloneToken: string | undefined, engineSourceSha: string | undefined): Promise<unknown> {
  validateShellSafeIdentifiers(owner, name, language);
  if (engineSourceSha !== undefined && !isValidSha(engineSourceSha)) {
    // Defensive: this value is interpolated directly into a shell command string below, same discipline
    // as owner/name/language via validateShellSafeIdentifiers - a 40-hex check is both the correct
    // version-identity validation AND sufficient shell-injection protection (no shell metacharacters
    // survive that pattern).
    throw new Error(`invalid engineSourceSha: "${engineSourceSha}"`);
  }
  const outPath = `/workspace/shadow-poll-result.json`;
  const lastSeenArg = lastSeenSha ? ` --last-seen-sha ${lastSeenSha}` : "";
  const engineShaArg = engineSourceSha ? ` --engine-source-sha ${engineSourceSha}` : "";
  const exec = await sandbox.exec(
    `cd /opt/diffci && npx tsx scripts/cloudflare-shadow-poll.ts --owner ${owner} --name ${name} --language ${language} --workspace /workspace --out ${outPath}${lastSeenArg}${engineShaArg}`,
    // GITHUB_CLONE_TOKEN via exec's env option, never the command string (same rule as GITHUB_TOKEN in
    // execAnalyzeBatch) - collector.ts's gitAuthEnv() turns it into a git extraheader for private-repo
    // clones. undefined is skipped per BaseExecOptions, so public-repo polls are byte-identical to before.
    { timeout: 240_000, env: { GITHUB_CLONE_TOKEN: cloneToken } },
  );
  if (!exec.success) throw new Error(`shadow-poll failed (exit ${exec.exitCode}): ${errorTail(exec)}`);
  const file = await sandbox.readFile(outPath);
  return JSON.parse(String(file.content));
}

async function shadowEnroll(request: Request, env: ValidationEnv): Promise<Response> {
  let body: { repository?: string; observationSource?: ObservationSource; language?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, error: "JSON body required" }, 400);
  }
  const repository = body.repository ?? "";
  const observationSource = body.observationSource ?? "cloudflare-poll";
  const language = body.language ?? "typescript";
  if (!/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/.test(repository)) {
    return json({ ok: false, error: "repository must be 'owner/name'" }, 400);
  }
  if (!/^[a-z]{1,20}$/.test(language)) {
    return json({ ok: false, error: "invalid language" }, 400);
  }
  const store = makeD1ShadowStore(env.RESEARCH_DB);
  await store.ensureRepository(repository, observationSource, language);
  const state = await store.getRepositoryPollState(repository);
  return json({ ok: true, repository, state: state?.state ?? "VALIDATING" });
}

interface ShadowPollOutcome {
  ok: boolean;
  repository: string;
  firstPoll?: boolean;
  newHeadSha?: string;
  predictionsRecorded: number;
  pollErrors: string[];
  error?: string;
  /** true when the repository's state (PAUSED/REMOVED) refused the poll - a caller distinction, not a failure. */
  refusedByState?: boolean;
}

/** The poll flow shared by POST /v1/shadow/poll and the autonomous cron runner - everything after
 * "we have a validated owner/name/language and a source tarball". Enrollment is the HTTP handler's
 * concern (enroll-on-first-poll behavior); the cron only ever polls already-enrolled repositories. */
async function executeShadowPoll(env: ValidationEnv, owner: string, name: string, language: string, source: File, engineSourceSha?: string): Promise<ShadowPollOutcome> {
  const repository = `${owner}/${name}`;
  const store = makeD1ShadowStore(env.RESEARCH_DB);
  const pollState = await store.getRepositoryPollState(repository);
  if (pollState?.state === "PAUSED" || pollState?.state === "REMOVED") {
    return { ok: false, repository, predictionsRecorded: 0, pollErrors: [], error: `repository is ${pollState.state} - not polling`, refusedByState: true };
  }

  const evidenceStore = new R2EvidenceStore(env.RESEARCH_BUCKET);
  const id = await buildSandboxSessionId(owner, name, 1);
  const sandbox = getSandbox(env.ResearchSandbox as any, `${id}-shadow-poll`, { enableDefaultSession: false, keepAlive: false, sleepAfter: "5m", transport: "rpc" });
  try {
    await prepareContainer(sandbox, source);
    // App installation token when the DiffCI Shadow App is installed on this repository (private-repo
    // clones), else undefined - public repositories clone anonymously exactly as before.
    const cloneToken = await githubTokenForRepo(env, repository);
    const result = (await execShadowPoll(sandbox, owner, name, language, pollState?.lastPolledSha, cloneToken, engineSourceSha)) as {
      ok: boolean; firstPoll?: boolean; newHeadSha: string; predictions?: any[]; errors?: string[]; error?: string;
    };
    await sandbox.destroy();
    // Full container result minus the bulky per-prediction plan payloads - the summary log line alone
    // proved insufficient while debugging the empty-prediction mystery (2026-08-21).
    console.log(
      `executeShadowPoll ${repository} raw result: ${JSON.stringify({ ...result, predictions: (result.predictions ?? []).map((p: any) => ({ logicalDeltaKey: p.logicalDeltaKey, planMode: p.planMode, fallback: p.fallback })) }).slice(0, 3000)}`,
    );
    if (!result.ok) return { ok: false, repository, predictionsRecorded: 0, pollErrors: [], error: result.error ?? "shadow-poll-failed" };

    let predictionsRecorded = 0;
    for (const prediction of result.predictions ?? []) {
      const r2Key = `shadow/predictions/${repository}/${prediction.logicalDeltaKey}`;
      await evidenceStore.put(r2Key, prediction);
      const { inserted } = await store.recordPrediction(
        {
          logicalDeltaKey: prediction.logicalDeltaKey, repository, baseSha: prediction.baseSha, headSha: prediction.headSha,
          diffciAnalysisVersion: prediction.diffciAnalysisVersion, graphVersion: prediction.graphVersion,
          shadowSchemaVersion: "stage2-shadow-poll-1", observationSource: "cloudflare-poll", planMode: prediction.planMode,
          fallback: prediction.fallback, effectiveGraphConfidence: prediction.effectiveGraphConfidence,
          opportunityCategory: prediction.opportunityCategory, testsSelectedDiffci: prediction.testsSelectedDiffci,
          testsSelectedPath: prediction.testsSelectedPath, testsTotalFull: prediction.testsTotalFull,
          diffciAnalysisOverheadMs: prediction.diffciAnalysisOverheadMs, predictionCreatedAt: prediction.predictionCreatedAt,
          // Stamped by cloudflare-shadow-poll.ts from the --engine-source-sha this call passed it - read
          // back per-prediction rather than reusing the outer `engineSourceSha` parameter directly, so a
          // caller that didn't pass one (or a script run standalone without the flag) is recorded as
          // genuinely unknown rather than silently defaulted.
          engineSourceSha: prediction.engineSourceSha,
        },
        r2Key,
      );
      if (inserted) predictionsRecorded++;
    }

    await store.updateLastPolled(repository, result.newHeadSha);
    if (predictionsRecorded > 0 && pollState?.state === "VALIDATING") {
      await store.setRepositoryState(repository, "SHADOW_ACTIVE");
    }

    return {
      ok: true, repository, firstPoll: result.firstPoll ?? false, newHeadSha: result.newHeadSha,
      predictionsRecorded, pollErrors: result.errors ?? [],
    };
  } catch (error: unknown) {
    try { await sandbox.destroy(); } catch { /* best-effort cleanup */ }
    return { ok: false, repository, predictionsRecorded: 0, pollErrors: [], error: error instanceof Error ? error.message : String(error) };
  }
}

async function shadowPoll(request: Request, env: ValidationEnv): Promise<Response> {
  const contentLength = Number(request.headers.get("Content-Length") || "0");
  if (contentLength > MAX_SOURCE_ARCHIVE_BYTES + 64 * 1024) {
    return json({ ok: false, error: "source-archive-too-large" }, 413);
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, error: "multipart-form-required" }, 400);
  }
  const source = form.get("source");
  if (!(source instanceof File) || source.size < 1 || source.size > MAX_SOURCE_ARCHIVE_BYTES) {
    return json({ ok: false, error: "valid-source-archive-required" }, 400);
  }
  const owner = String(form.get("owner") || "");
  const name = String(form.get("name") || "");
  const language = String(form.get("language") || "typescript");
  if (!owner || !name) return json({ ok: false, error: "owner and name required" }, 400);
  validateShellSafeIdentifiers(owner, name, language);
  // This is the ad-hoc, caller-supplied-source path (predates and remains independent of the R2
  // source-integrity system, which only gates the AUTONOMOUS cron/webhook pollers - see
  // shadow-source-integrity.ts's module comment). sourceSha here is an optional, best-effort caller
  // claim about what they uploaded, not independently verified against anything: recorded when present,
  // left genuinely unknown (NULL) when absent, never guessed.
  const rawSourceSha = String(form.get("sourceSha") || "");
  const engineSourceSha = rawSourceSha ? (isValidSha(rawSourceSha) ? rawSourceSha : undefined) : undefined;
  if (rawSourceSha && !engineSourceSha) {
    return json({ ok: false, error: `sourceSha, when supplied, must be a full 40-hex-character git SHA (got "${rawSourceSha}")` }, 400);
  }

  const store = makeD1ShadowStore(env.RESEARCH_DB);
  await store.ensureRepository(`${owner}/${name}`, "cloudflare-poll", language);

  const outcome = await executeShadowPoll(env, owner, name, language, source, engineSourceSha);
  if (!outcome.ok) {
    return json({ ok: false, owner, name, error: outcome.error }, outcome.refusedByState ? 409 : 500);
  }
  return json({
    ok: true, repository: outcome.repository, firstPoll: outcome.firstPoll ?? false, newHeadSha: outcome.newHeadSha,
    predictionsRecorded: outcome.predictionsRecorded, pollErrors: outcome.pollErrors,
  });
}

/** The best available GitHub token for reading a repository's ground truth: the App's per-installation
 * token when the DiffCI Shadow App is installed there (works for private design-partner repos, and its
 * rate limit scales with the installation), else the account-wide GITHUB_TOKEN, else nothing
 * (unauthenticated 50 req/h - how the pipeline ran before any token existed). Never throws: a failed
 * token exchange is logged and degrades to the fallback rather than blocking reconciliation. */
async function githubTokenForRepo(env: ValidationEnv, repository: string): Promise<string | undefined> {
  if (env.SHADOW_GITHUB_APP_ID && env.SHADOW_GITHUB_APP_PRIVATE_KEY) {
    try {
      const installationId = await makeD1ShadowStore(env.RESEARCH_DB).getInstallationId(repository);
      if (installationId) {
        const jwt = await signAppJwt({ appId: env.SHADOW_GITHUB_APP_ID, privateKeyPkcs8Pem: env.SHADOW_GITHUB_APP_PRIVATE_KEY });
        const { token } = await exchangeInstallationToken(jwt, installationId);
        return token;
      }
    } catch (error: unknown) {
      console.log(`githubTokenForRepo: installation-token exchange failed for ${repository}, falling back to GITHUB_TOKEN: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return env.GITHUB_TOKEN;
}

/** The reconcile flow shared by POST /v1/shadow/reconcile and the autonomous cron runner. No container
 * involved - GitHub API + D1/R2 only. */
async function executeShadowReconcile(env: ValidationEnv, repository: string, limit: number): Promise<{ attempted: number; reconciled: number; stillPending: number; errors: string[] }> {
  const store = makeD1ShadowStore(env.RESEARCH_DB);
  const evidenceStore = new R2EvidenceStore(env.RESEARCH_BUCKET);
  const pending = await store.findPendingPredictions(repository, limit);
  const githubToken = pending.length > 0 ? await githubTokenForRepo(env, repository) : undefined;

  let reconciled = 0;
  let stillPending = 0;
  const errors: string[] = [];
  for (const row of pending) {
    try {
      const predictionBlob = (await evidenceStore.get(row.r2EvidenceKey)) as any;
      if (!predictionBlob) {
        errors.push(`${row.logicalDeltaKey}: prediction evidence missing from R2 at ${row.r2EvidenceKey}`);
        continue;
      }
      const result = await reconcilePrediction(
        {
          logicalDeltaKey: predictionBlob.logicalDeltaKey, repository: predictionBlob.repository, headSha: predictionBlob.headSha,
          plan: predictionBlob.plan, pathSelectedTaskIds: predictionBlob.pathSelectedTaskIds,
          diffciAnalysisOverheadMs: predictionBlob.diffciAnalysisOverheadMs, predictionCreatedAt: predictionBlob.predictionCreatedAt,
        },
        { token: githubToken, checkFlakiness: true },
      );
      if (result.status === "STILL_PENDING") {
        stillPending++;
        // Best-effort telemetry for GET /v1/shadow/reconcile-diagnostics - never let a write failure here
        // fail the reconcile attempt itself (same posture as recordCronRun's telemetry handling).
        try {
          await store.recordReconcileAttempt(row.logicalDeltaKey, result.pendingReason, result.groundTruthFetchedAt);
        } catch (telemetryError: unknown) {
          console.log(`executeShadowReconcile: failed to record reconcile-attempt telemetry for ${row.logicalDeltaKey}: ${telemetryError instanceof Error ? telemetryError.message : String(telemetryError)}`);
        }
        continue;
      }
      const logicalEventKey = computeLogicalEventKey({ repository, headSha: row.headSha, workflowRunId: result.workflowRunId });
      const r2Key = `shadow/ground-truth/${repository}/${logicalEventKey}`;
      await evidenceStore.put(r2Key, result);
      await store.recordGroundTruth(
        {
          logicalEventKey, logicalDeltaKey: row.logicalDeltaKey, repository, headSha: row.headSha,
          workflowRunId: result.workflowRunId, workflowRunAttempt: 1, eventType: "poll-detected",
          workflowConclusion: result.workflowConclusion, workflowCompletedAt: result.workflowCompletedAt,
          groundTruthStatus: result.groundTruthStatus ?? "UNAVAILABLE", relevantFailuresObserved: result.relevantFailuresObserved ?? 0,
          relevantFailuresEvaluable: result.relevantFailuresEvaluable ?? 0, failuresPreservedByDiffci: result.failuresPreservedByDiffci ?? 0,
          failuresPreservedByPath: result.failuresPreservedByPath ?? 0, predictionPrecededGroundTruth: result.predictionPrecededGroundTruth ?? false,
          groundTruthFetchedAt: result.groundTruthFetchedAt,
        },
        r2Key,
      );
      reconciled++;
    } catch (error: unknown) {
      errors.push(`${row.logicalDeltaKey}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { attempted: pending.length, reconciled, stillPending, errors };
}

async function shadowReconcile(request: Request, env: ValidationEnv): Promise<Response> {
  let body: { repository?: string; limit?: number };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, error: "JSON body required" }, 400);
  }
  const repository = body.repository ?? "";
  const limit = Math.max(1, Math.min(25, body.limit ?? 10));
  if (!repository) return json({ ok: false, error: "repository required" }, 400);

  const result = await executeShadowReconcile(env, repository, limit);
  return json({ ok: true, repository, ...result });
}

async function shadowStatus(request: Request, env: ValidationEnv): Promise<Response> {
  const url = new URL(request.url);
  const repository = url.searchParams.get("repository") ?? "";
  if (!repository) return json({ ok: false, error: "repository query param required" }, 400);
  const store = makeD1ShadowStore(env.RESEARCH_DB);
  const summary = await store.getRepositorySummary(repository);
  if (!summary) return json({ ok: false, error: "repository not enrolled" }, 404);
  return json({ ok: true, ...summary });
}

// ============================================================================================
// Stage 2 autonomous polling (2026-08-21) - the Cron Trigger runner. Decision logic lives in
// shadow-cron.ts (unit-tested against fakes); this section wires the real D1/R2/Sandbox/GitHub
// implementations and exposes the same run via POST /v1/shadow/cron-run (manual trigger, used to
// verify the full autonomous path end-to-end without waiting for the schedule) plus
// GET /v1/shadow/cron-status (recent run telemetry). The diffci source tarball the polls need is
// uploaded once to R2 via POST /v1/shadow/source (scripts/upload-shadow-source.ts) - that upload is
// what removes the per-request source dependency that kept polling session-driven.
// ============================================================================================

// Source-version integrity (2026-08-21 fix, src/research/cloudflare/shadow-source-integrity.ts): the
// archive itself lives at an IMMUTABLE, content-addressed key per commit SHA - never overwritten, so two
// racing uploads of different SHAs can never corrupt each other's bytes (see the module doc comment for
// the full race-safety argument). SHADOW_SOURCE_META_KEY is the one MUTABLE pointer, written LAST in
// shadowSourceUpload (after the archive bytes are already durably stored) - "current" always means
// "whatever the most recent successful upload's meta write named," and a reader that races a concurrent
// upload sees either the old, fully-consistent (archive, meta) pair or the new one, never a mix.
const SHADOW_SOURCE_META_KEY = "shadow/source/current-meta";
function shadowSourceArchiveKey(sourceSha: string): string {
  return `shadow/source/by-sha/${sourceSha}.tgz`;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** POST /v1/shadow/source - see scripts/upload-shadow-source.ts (the only intended caller; also called
 * by the canonical scripts/deploy-research-sandbox.ts pipeline). `sourceSha` and `archiveHash` are
 * REQUIRED, not optional conveniences: this is exactly the "reject malformed/missing version metadata"
 * requirement the 2026-08-21 fix introduced. `sourceSha` must be the git commit the uploader actually
 * packaged (upload-shadow-source.ts computes it from `git rev-parse HEAD` and refuses to run against a
 * dirty working tree) - the Worker cannot itself verify that claim against anything (it has no git
 * access), but it DOES independently recompute archiveHash from the bytes it actually received and
 * rejects a mismatch, which at minimum catches transport corruption/truncation and a caller sending a
 * hash that doesn't match its own upload. */
async function shadowSourceUpload(request: Request, env: ValidationEnv): Promise<Response> {
  const contentLength = Number(request.headers.get("Content-Length") || "0");
  if (contentLength > MAX_SOURCE_ARCHIVE_BYTES + 64 * 1024) {
    return json({ ok: false, error: "source-archive-too-large" }, 413);
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, error: "multipart-form-required" }, 400);
  }
  const source = form.get("source");
  if (!(source instanceof File) || source.size < 1 || source.size > MAX_SOURCE_ARCHIVE_BYTES) {
    return json({ ok: false, error: "valid-source-archive-required" }, 400);
  }
  const sourceSha = String(form.get("sourceSha") || "");
  if (!isValidSha(sourceSha)) {
    return json({ ok: false, error: "sourceSha required: a full 40-hex-character git commit SHA of the exact tree being packaged (see scripts/upload-shadow-source.ts)" }, 400);
  }
  const claimedHash = String(form.get("archiveHash") || "");
  const label = String(form.get("label") || "");
  const bytes = await source.arrayBuffer();
  const archiveHash = await sha256Hex(bytes);
  if (claimedHash && claimedHash !== archiveHash) {
    // Never silently accept bytes that don't match what the uploader thinks it sent - a corrupted or
    // truncated upload must be visibly rejected, not stored as if it were the real archive for this SHA.
    return json({ ok: false, error: `archiveHash mismatch: uploader claimed ${claimedHash}, server computed ${archiveHash} from the received bytes - upload likely corrupted, retry` }, 400);
  }

  const archiveKey = shadowSourceArchiveKey(sourceSha);
  const evidenceStore = new R2EvidenceStore(env.RESEARCH_BUCKET);
  // Collision guard: a real git SHA is immutable, so re-uploading the SAME sha should always produce the
  // SAME bytes. If it doesn't, something is actually wrong (a hash collision is astronomically unlikely -
  // far more likely is a caller passing a stale/wrong sourceSha for genuinely different content) and this
  // must be surfaced loudly rather than silently overwriting the earlier archive for that SHA.
  const existing = await env.RESEARCH_BUCKET.get(archiveKey);
  if (existing) {
    const existingHash = await sha256Hex(await existing.arrayBuffer());
    if (existingHash !== archiveHash) {
      return json({ ok: false, error: `source-sha-collision: an archive already exists for ${sourceSha} with a DIFFERENT content hash (${existingHash} vs this upload's ${archiveHash}) - refusing to overwrite` }, 409);
    }
    // Identical content already stored under this SHA - fall through to (re-)writing the meta pointer
    // only; re-writing byte-identical archive bytes would be a wasted R2 write.
  } else {
    await env.RESEARCH_BUCKET.put(archiveKey, bytes);
  }

  const meta: SourceArchiveMeta = { sourceSha, archiveHash, archiveKey, uploadedAt: new Date().toISOString(), sizeBytes: bytes.byteLength, label: label || undefined };
  // Meta pointer written LAST, after the archive bytes are durably stored - see the section comment.
  await evidenceStore.put(SHADOW_SOURCE_META_KEY, meta);
  return json({ ok: true, ...meta });
}

/** The single source of truth GET /v1/shadow/cron-status, shadow-cron.ts's autonomous poller, and the
 * webhook's push-triggered poll all call - see computeSourceIntegrity's doc comment for why this must
 * never drift between "what the status endpoint reports" and "what actually gates a poll". */
async function checkSourceIntegrity(env: ValidationEnv): Promise<{ result: ReturnType<typeof computeSourceIntegrity>; meta: SourceArchiveMeta | undefined }> {
  const meta = (await new R2EvidenceStore(env.RESEARCH_BUCKET).get(SHADOW_SOURCE_META_KEY)) as SourceArchiveMeta | undefined;
  const archiveBytesExist = meta && isValidSha(meta.sourceSha) ? await new R2EvidenceStore(env.RESEARCH_BUCKET).headExists(meta.archiveKey ?? shadowSourceArchiveKey(meta.sourceSha)) : false;
  const result = computeSourceIntegrity(env.EXPECTED_SOURCE_SHA, meta, archiveBytesExist);
  return { result, meta };
}

async function loadVerifiedShadowSource(env: ValidationEnv): Promise<VerifiedSourceArchive> {
  const { result, meta } = await checkSourceIntegrity(env);
  if (result.status !== "CURRENT" || !meta) {
    return result as VerifiedSourceArchive;
  }
  const obj = await env.RESEARCH_BUCKET.get(meta.archiveKey);
  const bytes = obj ? await obj.arrayBuffer() : undefined;
  if (!bytes || bytes.byteLength < 1) {
    // The headExists() check above passed but the actual read failed/came back empty - an R2 read-after-
    // write race or a genuinely corrupted object. Fail closed exactly like a MISSING status rather than
    // trusting the integrity check alone.
    return { ...result, status: "MISSING", detail: `archive object at "${meta.archiveKey}" exists but could not be read (empty or failed fetch)` } as VerifiedSourceArchive;
  }
  return { ...result, status: "CURRENT", file: new File([new Uint8Array(bytes)], "diffci-source.tgz"), archiveSha: meta.sourceSha } as VerifiedSourceArchive;
}

/** One cheap REST call to decide whether a repository's default branch moved since the last poll,
 * before spending a multi-minute container on it. Uses GITHUB_TOKEN when configured (5000 req/h);
 * unauthenticated otherwise. Never throws for rate-limit/network trouble - the caller polls anyway. */
async function fetchDefaultBranchHead(repository: string, token?: string): Promise<{ sha: string } | { gone: string } | undefined> {
  try {
    const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "diffci-shadow-cron" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`https://api.github.com/repos/${repository}/commits?per_page=1`, { headers });
    if (res.status === 404 || res.status === 451) return { gone: `HTTP ${res.status}` };
    if (!res.ok) return undefined;
    const body = (await res.json()) as Array<{ sha?: string }>;
    const sha = body?.[0]?.sha;
    return sha ? { sha } : undefined;
  } catch {
    return undefined;
  }
}

function makeShadowCronDeps(env: ValidationEnv): ShadowCronDeps {
  const store = makeD1ShadowStore(env.RESEARCH_DB);
  return {
    listPollableRepositories: () => store.listPollableRepositories(),
    // M3.2: persists per-repository liveness so "DiffCI is broken" and "this repository is quiet" can be
    // told apart. Without it both look identical - no new predictions and a frozen timestamp.
    recordRepositoryLiveness: (updates) => store.recordRepositoryLiveness(updates),
    // Hard daily ceiling on analysis launches - maxPollsPerRun bounds a sweep, never the day's spend.
    reserveLaunchSlot: (repository, maxPerDay) => store.reserveLaunchSlot(repository, maxPerDay),
    recordLaunchOutcome: (slotNo, outcome) => store.recordLaunchOutcome(slotNo, outcome),
    recordHeadTransition: (t) => store.recordHeadTransition(t),
    listReconcilableRepositories: () => store.listReconcilableRepositories(),
    // Per-repo token so the head pre-check also works on private repositories with an App
    // installation; githubTokenForRepo degrades to GITHUB_TOKEN/anonymous for everything else.
    fetchRemoteHead: async (repository) => fetchDefaultBranchHead(repository, await githubTokenForRepo(env, repository)),
    getVerifiedSourceArchive: () => loadVerifiedShadowSource(env),
    async pollRepository(repo: PollableRepository, source: File, engineSourceSha: string) {
      const [owner, name] = repo.repository.split("/");
      validateShellSafeIdentifiers(owner ?? "", name ?? "", repo.language);
      const outcome = await executeShadowPoll(env, owner!, name!, repo.language, source, engineSourceSha);
      if (!outcome.ok) throw new Error(outcome.error ?? "shadow-poll-failed");
      return { predictionsRecorded: outcome.predictionsRecorded, errors: outcome.pollErrors };
    },
    async reconcileRepository(repository: string) {
      return executeShadowReconcile(env, repository, DEFAULT_SHADOW_CRON_CONFIG.reconcileLimitPerRepo);
    },
    recordCronRun: (run) =>
      store.recordCronRun({
        startedAt: run.startedAt, finishedAt: run.finishedAt, trigger: run.trigger,
        reposConsidered: run.reposConsidered, headChecksSkipped: run.headChecksSkipped, reposPolled: run.reposPolled,
        predictionsRecorded: run.predictionsRecorded, reposReconciled: run.reposReconciled,
        groundTruthReconciled: run.groundTruthReconciled, stillPending: run.stillPending, errors: run.errors,
        sourceIntegrityStatus: run.sourceIntegrityStatus,
      }),
    now: () => new Date(),
    log: (message) => console.log(message),
  };
}

async function shadowCronRun(request: Request, env: ValidationEnv): Promise<Response> {
  let maxPolls = DEFAULT_SHADOW_CRON_CONFIG.maxPollsPerRun;
  try {
    const body = (await request.json()) as { maxPolls?: number };
    if (typeof body.maxPolls === "number") maxPolls = Math.max(0, Math.min(5, body.maxPolls));
  } catch {
    // empty body is fine - defaults apply
  }
  const record = await runShadowCronOnce(makeShadowCronDeps(env), { ...DEFAULT_SHADOW_CRON_CONFIG, maxPollsPerRun: maxPolls }, "manual");
  return json({ ok: true, ...record });
}

/** Minimal ExecutionContext shape - not importing workers-types for one method (same pattern as the
 * hand-rolled D1Binding/R2Binding interfaces). */
interface ExecutionCtx {
  waitUntil(promise: Promise<unknown>): void;
}

// ============================================================================================
// Stage 2 GitHub App webhook route (2026-08-21) - POST /v1/shadow/webhook. Event decisions live in
// shadow-webhook.ts (unit-tested); this wires the real HMAC secret, D1 store, and ctx.waitUntil
// scheduling. NO bearer auth on this route - GitHub is the caller, and the HMAC signature over the
// raw body (App webhook secret) is the authentication; a missing secret disables the route entirely
// (503) rather than accepting unverifiable deliveries.
// ============================================================================================

async function shadowWebhook(request: Request, env: ValidationEnv, ctx: ExecutionCtx): Promise<Response> {
  const secret = env.SHADOW_GITHUB_WEBHOOK_SECRET;
  if (!secret) return json({ ok: false, error: "webhook-not-configured (SHADOW_GITHUB_WEBHOOK_SECRET unset)" }, 503);
  const rawBody = await request.text();
  const store = makeD1ShadowStore(env.RESEARCH_DB);

  const outcome = await handleShadowWebhook(
    request.headers.get("X-GitHub-Event"),
    request.headers.get("X-Hub-Signature-256"),
    rawBody,
    {
      verifySignature: (body, signature) => verifyWebhookSignature(body, signature, secret),
      ensureRepository: (repository, language) => store.ensureRepository(repository, "github-app-webhook", language),
      setInstallationId: (repository, installationId) => store.setInstallationId(repository, installationId),
      schedulePoll: (repository) => {
        ctx.waitUntil(
          (async () => {
            const [owner, name] = repository.split("/");
            const pollState = await store.getRepositoryPollState(repository);
            const language = pollState?.language ?? "typescript";
            validateShellSafeIdentifiers(owner ?? "", name ?? "", language);
            const verified = await loadVerifiedShadowSource(env);
            if (verified.status !== "CURRENT") {
              // Same fail-closed rule as the cron path (shadow-cron.ts) - a STALE/MISSING/UNKNOWN source
              // must not silently produce a prediction. The next cron tick's reconcile sweep still covers
              // this repository regardless; only the instant-poll latency benefit is lost this once.
              console.log(`shadow-webhook: push for ${repository} refused - source-integrity-${verified.status}: ${verified.detail}`);
              return;
            }
            const result = await executeShadowPoll(env, owner!, name!, language, verified.file, verified.archiveSha);
            // pollErrors carries per-commit analysis failures even when ok=true - a poll that saw new
            // commits but predicted nothing is invisible without them (real debugging gap 2026-08-21).
            console.log(
              `shadow-webhook: push-triggered poll for ${repository}: ok=${result.ok} predictions=${result.predictionsRecorded}${result.error ? ` error=${result.error}` : ""}${result.pollErrors.length ? ` pollErrors=${JSON.stringify(result.pollErrors).slice(0, 2000)}` : ""}`,
            );
          })().catch((error: unknown) => console.log(`shadow-webhook: push-triggered poll for ${repository} failed: ${error instanceof Error ? error.message : String(error)}`)),
        );
      },
      scheduleReconcile: (repository) => {
        ctx.waitUntil(
          executeShadowReconcile(env, repository, DEFAULT_SHADOW_CRON_CONFIG.reconcileLimitPerRepo)
            .then((r) => console.log(`shadow-webhook: workflow_run-triggered reconcile for ${repository}: reconciled=${r.reconciled} stillPending=${r.stillPending} errors=${r.errors.length}`))
            .catch((error: unknown) => console.log(`shadow-webhook: reconcile for ${repository} failed: ${error instanceof Error ? error.message : String(error)}`)),
        );
      },
      log: (message) => console.log(message),
    },
  );
  return json(outcome.body, outcome.status);
}

/** Diagnostic: what GitHub actually has on file for the registered App (GET /app authenticated as
 * the App itself) - added while debugging why installation events arrived but push events did not
 * (installation events are delivered unconditionally; push/workflow_run require the App's event
 * subscriptions to include them, which only this endpoint can confirm without the App owner's UI). */
async function shadowAppInfo(env: ValidationEnv, deliveryId?: string): Promise<Response> {
  if (!env.SHADOW_GITHUB_APP_ID || !env.SHADOW_GITHUB_APP_PRIVATE_KEY) {
    return json({ ok: false, error: "app-credentials-not-configured" }, 503);
  }
  try {
    const jwt = await signAppJwt({ appId: env.SHADOW_GITHUB_APP_ID, privateKeyPkcs8Pem: env.SHADOW_GITHUB_APP_PRIVATE_KEY });

    // Ask GitHub to redeliver one webhook delivery - lets us re-trigger a real, correctly-signed
    // delivery on demand while watching logs, without waiting for the next real push.
    if (deliveryId && deliveryId.startsWith("redeliver:")) {
      const id = deliveryId.slice("redeliver:".length);
      if (!/^\d{1,25}$/.test(id)) return json({ ok: false, error: "invalid delivery id" }, 400);
      const redeliverRes = await fetch(`https://api.github.com/app/hook/deliveries/${id}/attempts`, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "User-Agent": "diffci-shadow" },
      });
      return json({ ok: redeliverRes.ok, status: redeliverRes.status, body: (await redeliverRes.text()).slice(0, 300) });
    }

    // Drill into one delivery: GitHub stores the exact request payload and OUR exact response body.
    if (deliveryId && /^\d{1,25}$/.test(deliveryId)) {
      const detailRes = await fetch(`https://api.github.com/app/hook/deliveries/${deliveryId}`, {
        headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "User-Agent": "diffci-shadow" },
      });
      if (!detailRes.ok) return json({ ok: false, error: `GET delivery detail failed (${detailRes.status})` }, 502);
      const detail = (await detailRes.json()) as { event: string; action: string | null; status_code: number; response?: { payload?: unknown }; request?: { payload?: { ref?: string; repository?: { full_name?: string; default_branch?: string } } } };
      return json({
        ok: true,
        event: detail.event,
        action: detail.action,
        statusCode: detail.status_code,
        ourResponse: detail.response?.payload,
        requestRef: detail.request?.payload?.ref,
        requestRepository: detail.request?.payload?.repository?.full_name,
        requestDefaultBranch: detail.request?.payload?.repository?.default_branch,
      });
    }
    const res = await fetch("https://api.github.com/app", {
      headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "User-Agent": "diffci-shadow" },
    });
    if (!res.ok) return json({ ok: false, error: `GET /app failed (${res.status}): ${(await res.text()).slice(0, 300)}` }, 502);
    const app = (await res.json()) as { slug?: string; name?: string; events?: string[]; permissions?: Record<string, string> };

    // GitHub's own webhook delivery log for this App - status per delivery, from the horse's mouth.
    const deliveriesRes = await fetch("https://api.github.com/app/hook/deliveries?per_page=15", {
      headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "User-Agent": "diffci-shadow" },
    });
    // Delivery ids are 19-digit integers - beyond Number.MAX_SAFE_INTEGER, so JSON.parse silently
    // rounds them (a real 404 bug hit while debugging: the rounded id doesn't exist). Extract the
    // exact id strings from the raw body BEFORE parsing.
    let deliveries: unknown;
    if (deliveriesRes.ok) {
      const rawList = await deliveriesRes.text();
      const exactIds = [...rawList.matchAll(/"id":\s*(\d+)/g)].map((m) => m[1]!);
      const parsed = JSON.parse(rawList) as Array<{ event: string; action: string | null; status: string; status_code: number; delivered_at: string; redelivery: boolean }>;
      deliveries = parsed.map((d, i) => ({ id: exactIds[i], event: d.event, action: d.action, status: d.status, statusCode: d.status_code, deliveredAt: d.delivered_at, redelivery: d.redelivery }));
    } else {
      deliveries = `GET /app/hook/deliveries failed (${deliveriesRes.status})`;
    }

    return json({ ok: true, slug: app.slug, name: app.name, events: app.events, permissions: app.permissions, recentDeliveries: deliveries });
  } catch (error: unknown) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

async function shadowCronStatus(request: Request, env: ValidationEnv): Promise<Response> {
  const limit = Math.max(1, Math.min(50, Number.parseInt(new URL(request.url).searchParams.get("limit") ?? "10", 10) || 10));
  const store = makeD1ShadowStore(env.RESEARCH_DB);
  const [runs, repositories, integrity] = await Promise.all([
    store.listRecentCronRuns(limit),
    store.listPollableRepositories(),
    checkSourceIntegrity(env),
  ]);
  return json({
    ok: true,
    cronEnabled: env.SHADOW_CRON_ENABLED === "true",
    // Kept for back-compat with anything already reading this field; sourceIntegrity below is the
    // authoritative, gate-equivalent answer (same computeSourceIntegrity() call the cron/webhook poll
    // paths use before running any analysis - see checkSourceIntegrity's doc comment).
    sourceArchive: integrity.meta ?? null,
    sourceIntegrity: integrity.result,
    pollableRepositories: repositories,
    recentRuns: runs,
  });
}

const DEFAULT_STUCK_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4h - a diagnostic label only, never auto-terminal (Task 2 §11)

/** GET /v1/shadow/reconcile-diagnostics - Task 2 (2026-08-21) reconciliation observability (§10/§11):
 * total/reconciled/pending counts, WHY each pending prediction is pending (grouped), the oldest pending
 * prediction's age, and a stuck list (pending longer than the threshold - a read-time label, never a
 * stored state transition; see shadow-store.ts's ReconcileDiagnostics doc comment). */
async function shadowReconcileDiagnostics(request: Request, env: ValidationEnv): Promise<Response> {
  const url = new URL(request.url);
  const repository = url.searchParams.get("repository") ?? undefined;
  const stuckThresholdMs = Math.max(60_000, Number.parseInt(url.searchParams.get("stuckThresholdMs") ?? "", 10) || DEFAULT_STUCK_THRESHOLD_MS);
  const stuckLimit = Math.max(1, Math.min(100, Number.parseInt(url.searchParams.get("stuckLimit") ?? "20", 10) || 20));
  const store = makeD1ShadowStore(env.RESEARCH_DB);
  const diagnostics = await store.getReconcileDiagnostics({ repository, nowIso: new Date().toISOString(), stuckThresholdMs, stuckLimit });
  return json({ ok: true, repository: repository ?? "all", stuckThresholdMs, ...diagnostics });
}

/** Wires the real D1/R2 bindings to resumable-batch.ts's abstract ResumabilityStore/PersistenceStore
 * interfaces. extraFieldsByKey supplies the D1 columns beyond (logicalDeltaKey, r2EvidenceKey) that the
 * generic PersistenceStore interface doesn't know about (repository, base/head SHA, fallback, graph
 * confidence) - looked up per-call rather than widening the shared interface for one caller's schema. */
function makeD1ResumabilityAdapter(
  db: D1Binding,
  bucket: R2Binding,
  experimentId: string,
  repository: string,
  extraFieldsByKey: Map<string, { baseSha: string; headSha: string; fallback: boolean; graphConfidence: string }>,
) {
  const evidenceStore = new R2EvidenceStore(bucket);
  return {
    async findCompleted(logicalDeltaKeys: string[]) {
      if (logicalDeltaKeys.length === 0) return [];
      const placeholders = logicalDeltaKeys.map(() => "?").join(",");
      const { results } = await db
        .prepare(`SELECT logical_delta_key, r2_evidence_key FROM completed_deltas WHERE logical_delta_key IN (${placeholders})`)
        .bind(...logicalDeltaKeys)
        .all<{ logical_delta_key: string; r2_evidence_key: string }>();
      return results.map((r) => ({ logicalDeltaKey: r.logical_delta_key, r2EvidenceKey: r.r2_evidence_key }));
    },
    async evidenceIsValid(r2EvidenceKey: string) {
      try {
        const value = await evidenceStore.get(r2EvidenceKey);
        return value !== undefined && value !== null;
      } catch {
        return false;
      }
    },
    async putEvidence(r2EvidenceKey: string, record: unknown) {
      await evidenceStore.put(r2EvidenceKey, record);
    },
    async recordCompleted(logicalDeltaKey: string, r2EvidenceKey: string) {
      const extra = extraFieldsByKey.get(logicalDeltaKey);
      const now = new Date().toISOString();
      const result = await db
        .prepare(
          `INSERT INTO completed_deltas (logical_delta_key, experiment_id, repository, base_sha, head_sha, r2_evidence_key, fallback, graph_confidence, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(logical_delta_key) DO NOTHING`,
        )
        .bind(logicalDeltaKey, experimentId, repository, extra?.baseSha ?? "", extra?.headSha ?? "", r2EvidenceKey, extra?.fallback ? 1 : 0, extra?.graphConfidence ?? "UNKNOWN", now)
        .run();
      return { inserted: (result.meta?.changes ?? 0) > 0 };
    },
  };
}

// completed_deltas and repository_runs both carry a FOREIGN KEY REFERENCES experiment_runs(experiment_id)
// (schema.sql) - a real bug found live in Gate A: attemptRepoRun() referenced experimentId in both
// tables without ever inserting the parent experiment_runs row first, so the very first insert failed
// outright with SQLITE_CONSTRAINT_FOREIGNKEY. ON CONFLICT DO NOTHING makes this idempotent across the
// many repository runs (and retries) that share one experimentId.
async function ensureExperimentRun(db: D1Binding, experimentId: string, targetRepositories: number, targetCommitDeltas: number, versionLabel: string): Promise<void> {
  const now = new Date().toISOString();
  // Real bug found live in Gate 0 (2026-08-21): /v1/stop, called BEFORE the first /v1/orchestrate for a
  // brand-new experimentId, silently did nothing - its UPDATE affected zero rows because no
  // experiment_runs row existed yet, but the endpoint reported success regardless (fixed separately in
  // setStopRequested/stopExperiment). That fix means a stop-then-orchestrate sequence can now create
  // the row with real target_repositories/target_commit_deltas of 0 first; ON CONFLICT here self-heals
  // those placeholder values on the next real ensureExperimentRun() call instead of leaving them wrong
  // forever - but must NOT touch status/stop_requested, so a stop already recorded is never undone by a
  // later orchestrate call re-establishing the row.
  await db
    .prepare(
      `INSERT INTO experiment_runs (experiment_id, diffci_version, schema_version, target_repositories, target_commit_deltas, created_at, status)
       VALUES (?, ?, ?, ?, ?, ?, 'RUNNING')
       ON CONFLICT(experiment_id) DO UPDATE SET
         target_repositories = excluded.target_repositories,
         target_commit_deltas = excluded.target_commit_deltas,
         diffci_version = excluded.diffci_version,
         schema_version = excluded.schema_version`,
    )
    .bind(experimentId, versionLabel, versionLabel, targetRepositories, targetCommitDeltas, now)
    .run();
}

async function checkpointRepositoryRun(db: D1Binding, experimentId: string, repository: string, status: string, commitsAnalyzed: number): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO repository_runs (experiment_id, repository, status, commits_analyzed, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(experiment_id, repository) DO UPDATE SET status = excluded.status, commits_analyzed = excluded.commits_analyzed, completed_at = excluded.completed_at`,
    )
    .bind(experimentId, repository, status, commitsAnalyzed, now, now)
    .run();
}

async function attemptRepoRun(
  env: ValidationEnv,
  owner: string,
  name: string,
  language: string,
  targetCommits: number,
  batchSize: number,
  experimentId: string,
  source: File,
  attempt: number,
): Promise<RepoRunTelemetry> {
  const repository = `${owner}/${name}`;
  const id = await buildSandboxSessionId(owner, name, attempt);
  const sandbox = getSandbox(env.ResearchSandbox as any, id, { enableDefaultSession: false, keepAlive: false, sleepAfter: "5m", transport: "rpc" });

  try {
    await prepareContainer(sandbox, source);

    const sample = await execSampleCommits(sandbox, owner, name, language, targetCommits);
    if (sample.metadata.exclusionReason) {
      await checkpointRepositoryRun(env.RESEARCH_DB, experimentId, repository, "EXCLUDED", 0);
      await sandbox.destroy();
      return {
        owner, name, excluded: true, exclusionReason: sample.metadata.exclusionReason,
        candidateDeltas: 0, resumedDeltas: 0, invalidCheckpoints: 0, newDeltasAnalyzed: 0, duplicateDeltasPrevented: 0,
        batchesRun: 0, errors: [], metadata: sample.metadata, records: [],
      };
    }

    // Resumability decision happens BEFORE any real analysis is dispatched - see resumable-batch.ts.
    // extraFieldsByKey starts empty; it's populated per-batch below, right before each batch's persist
    // call, from that batch's own freshly-analyzed records (never needed for the *skip* decision, only
    // for writing the D1 row of something this attempt itself just analyzed).
    const extraFieldsByKey = new Map<string, { baseSha: string; headSha: string; fallback: boolean; graphConfidence: string }>();
    const store = makeD1ResumabilityAdapter(env.RESEARCH_DB, env.RESEARCH_BUCKET, experimentId, repository, extraFieldsByKey);
    const plan = await planResumableWork(sample.candidates, store);

    await checkpointRepositoryRun(env.RESEARCH_DB, experimentId, repository, "RUNNING", plan.resumedDeltas);

    const batches = batchDeltas(plan.todo, batchSize);
    const allRecords: AnalyzeBatchResult["records"] = [];
    // Fetch the resumed deltas' full evidence too, not just count them - a caller aggregating results
    // across a whole medium-batch run needs every candidate's data, whether it was newly analyzed by
    // THIS attempt or already complete from an earlier one. evidenceIsValid() already confirmed each of
    // these parses successfully, so this get() is expected to succeed.
    const evidenceStoreForResumed = new R2EvidenceStore(env.RESEARCH_BUCKET);
    for (const checkpoint of plan.resumed) {
      const record = (await evidenceStoreForResumed.get(checkpoint.r2EvidenceKey)) as AnalyzeBatchResult["records"][number] | undefined;
      if (record) allRecords.push(record);
    }
    const errors: string[] = [];
    let newDeltasAnalyzed = 0;
    let duplicateDeltasPrevented = 0;
    let analyzedSoFar = plan.resumedDeltas;

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i]!;
      const batchResult = await execAnalyzeBatch(sandbox, owner, name, language, batch, i, env.GITHUB_TOKEN);
      errors.push(...batchResult.errors);

      const persistable: PersistableResult[] = [];
      for (const record of batchResult.records) {
        const key = record.identity.logicalDeltaKey;
        const r2EvidenceKey = `medium-batch/${experimentId}/commits/${key}`;
        extraFieldsByKey.set(key, {
          baseSha: record.identity.baseSha,
          headSha: record.identity.headSha,
          fallback: record.fallback,
          graphConfidence: record.graphConfidence,
        });
        persistable.push({ logicalDeltaKey: key, r2EvidenceKey, record });
      }
      const outcome = await persistBatchResults(persistable, store);
      newDeltasAnalyzed += outcome.newDeltasAnalyzed;
      duplicateDeltasPrevented += outcome.duplicateDeltasPrevented;
      allRecords.push(...batchResult.records);
      analyzedSoFar += batchResult.records.length;

      // Checkpoint after EVERY batch, not just at the end - this is the mechanism that bounds a
      // mid-run failure's cost to one batch, not the whole repository.
      await checkpointRepositoryRun(env.RESEARCH_DB, experimentId, repository, "RUNNING", analyzedSoFar);
    }

    await checkpointRepositoryRun(env.RESEARCH_DB, experimentId, repository, "COMPLETE", analyzedSoFar);
    await sandbox.destroy();

    return {
      owner, name, excluded: false,
      candidateDeltas: sample.candidates.length,
      resumedDeltas: plan.resumedDeltas,
      invalidCheckpoints: plan.invalidCheckpoints,
      newDeltasAnalyzed,
      duplicateDeltasPrevented,
      batchesRun: batches.length,
      errors,
      metadata: sample.metadata,
      records: allRecords,
    };
  } catch (error: unknown) {
    try {
      await sandbox.destroy();
    } catch {
      // best-effort cleanup
    }
    throw error;
  }
}

async function runRepo(request: Request, env: ValidationEnv): Promise<Response> {
  const contentLength = Number(request.headers.get("Content-Length") || "0");
  if (contentLength > MAX_SOURCE_ARCHIVE_BYTES + 64 * 1024) {
    return json({ ok: false, error: "source-archive-too-large" }, 413);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, error: "multipart-form-required" }, 400);
  }
  const source = form.get("source");
  if (!(source instanceof File) || source.size < 1 || source.size > MAX_SOURCE_ARCHIVE_BYTES) {
    return json({ ok: false, error: "valid-source-archive-required" }, 400);
  }
  const owner = String(form.get("owner") || "");
  const name = String(form.get("name") || "");
  const language = String(form.get("language") || "typescript");
  const experimentId = String(form.get("experimentId") || "stage0-medium-batch-2026-08-21");
  const targetCommits = Math.max(1, Math.min(100, Number.parseInt(String(form.get("targetCommits") || "50"), 10) || 50));
  const batchSize = Math.max(1, Math.min(25, Number.parseInt(String(form.get("batchSize") || "10"), 10) || 10));
  const targetRepositories = Math.max(1, Number.parseInt(String(form.get("targetRepositories") || "10"), 10) || 10);
  const targetCommitDeltas = Math.max(1, Number.parseInt(String(form.get("targetCommitDeltas") || "500"), 10) || 500);
  if (!owner || !name) return json({ ok: false, error: "owner and name required" }, 400);

  try {
    // Must exist before repository_runs/completed_deltas can reference it (FOREIGN KEY, schema.sql) -
    // idempotent across every repository run and retry that shares this experimentId.
    await ensureExperimentRun(env.RESEARCH_DB, experimentId, targetRepositories, targetCommitDeltas, "stage0-medium-batch");

    const { result, attempts, retryReasons } = await withContainerRetry((attempt) =>
      attemptRepoRun(env, owner, name, language, targetCommits, batchSize, experimentId, source, attempt),
    );

    if (retryReasons.length > 0) {
      console.log(`diffci-research-sandbox run-repo: ${owner}/${name} succeeded after ${attempts} attempt(s): ${retryReasons.join(" | ")}`);
    }

    return json({
      ok: true,
      experimentId,
      reliability: { attempts, retried: retryReasons.length > 0, retryReasons },
      ...result,
    });
  } catch (error: unknown) {
    return json({ ok: false, owner, name, error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

// ============================================================================================
// Full Stage 0 multi-repository orchestrator (2026-08-21) - the "CRITICAL PRECONDITION" the medium-
// batch report flagged before spending full-experiment budget. Coordinates ~20 repositories with
// bounded concurrency, paced across repeated stateless invocations. Every invocation re-derives ALL
// state (which repositories are done, current budget) from D1 - see orchestrator-plan.ts's header
// comment for why this makes "a new orchestrator invocation must reconstruct state from persistent
// storage" true without a special recovery path: a resumed invocation and a fresh one are identical.
// ============================================================================================

async function queryRepositoryStates(db: D1Binding, experimentId: string): Promise<Map<string, RepositoryState>> {
  const { results } = await db
    .prepare("SELECT repository, status, orchestrator_attempts FROM repository_runs WHERE experiment_id = ?")
    .bind(experimentId)
    .all<{ repository: string; status: string; orchestrator_attempts: number }>();
  const map = new Map<string, RepositoryState>();
  for (const row of results) {
    const [owner, name] = row.repository.split("/");
    map.set(row.repository, { owner: owner ?? "", name: name ?? "", status: row.status as RepositoryState["status"], orchestratorAttempts: row.orchestrator_attempts });
  }
  return map;
}

async function queryStopRequested(db: D1Binding, experimentId: string): Promise<boolean> {
  const { results } = await db.prepare("SELECT stop_requested FROM experiment_runs WHERE experiment_id = ?").bind(experimentId).all<{ stop_requested: number }>();
  return (results[0]?.stop_requested ?? 0) === 1;
}

async function setStopRequested(db: D1Binding, experimentId: string): Promise<boolean> {
  // Real bug found live in Gate 0 (2026-08-21): a plain UPDATE here silently did nothing when called
  // for an experimentId that had never been touched by /v1/orchestrate yet (no experiment_runs row to
  // update) - the endpoint reported {stopRequested: true} regardless, and the next /v1/orchestrate call
  // proceeded to dispatch real work because stop_requested was never actually set. Now an UPSERT, so a
  // stop issued before the first orchestrate call is honored: ensureExperimentRun()'s own upsert will
  // later self-heal the placeholder target_repositories/target_commit_deltas values here without
  // touching status/stop_requested.
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO experiment_runs (experiment_id, diffci_version, schema_version, target_repositories, target_commit_deltas, created_at, status, stop_requested)
       VALUES (?, 'pending-init', 'pending-init', 0, 0, ?, 'RUNNING', 1)
       ON CONFLICT(experiment_id) DO UPDATE SET stop_requested = 1`,
    )
    .bind(experimentId, now)
    .run();
  // Verify rather than trust: read the row back before reporting success, so a future regression of
  // this exact kind fails loudly (a 500 response) instead of silently reporting a stop that didn't happen.
  return queryStopRequested(db, experimentId);
}

async function incrementOrchestratorAttempts(db: D1Binding, experimentId: string, repository: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO repository_runs (experiment_id, repository, status, commits_analyzed, started_at, completed_at, orchestrator_attempts)
       VALUES (?, ?, 'RUNNING', 0, ?, ?, 1)
       ON CONFLICT(experiment_id, repository) DO UPDATE SET orchestrator_attempts = orchestrator_attempts + 1`,
    )
    .bind(experimentId, repository, now, now)
    .run();
}

async function markRepositoryFailed(db: D1Binding, experimentId: string, repository: string): Promise<void> {
  await db
    .prepare("UPDATE repository_runs SET status = 'FAILED', completed_at = ? WHERE experiment_id = ? AND repository = ?")
    .bind(new Date().toISOString(), experimentId, repository)
    .run();
}

interface CumulativeBudget {
  measuredUsd: number;
  estimatedUsd: number;
}

async function queryCumulativeBudget(db: D1Binding, experimentId: string): Promise<CumulativeBudget> {
  const { results } = await db
    .prepare("SELECT cumulative_measured_usd, cumulative_estimated_usd FROM budget_ledger WHERE experiment_id = ? ORDER BY id DESC LIMIT 1")
    .bind(experimentId)
    .all<{ cumulative_measured_usd: number; cumulative_estimated_usd: number }>();
  const row = results[0];
  return { measuredUsd: row?.cumulative_measured_usd ?? 0, estimatedUsd: row?.cumulative_estimated_usd ?? 0 };
}

async function appendBudgetLedgerRow(
  db: D1Binding,
  experimentId: string,
  repository: string,
  wallMs: number,
  cumulativeBefore: CumulativeBudget,
): Promise<{ status: string; cumulativeMeasuredUsd: number; cumulativeEstimatedUsd: number }> {
  const wallSeconds = wallMs / 1000;
  // Measured: real per-unit prices x a conservative (wall-clock, not sampled) usage estimate - see the
  // SANDBOX_* constants' header comment for why this counts as "measured" rather than "estimated" here
  // (it's the exact formula the deployed instance type implies, not a placeholder).
  const measuredUsd =
    wallSeconds * SANDBOX_VCPUS * 0.00002 + wallSeconds * SANDBOX_MEMORY_GIB * 0.0000025 + wallSeconds * SANDBOX_DISK_GB * 0.00000007;
  const cumulativeMeasuredUsd = cumulativeBefore.measuredUsd + measuredUsd;
  const cumulativeEstimatedUsd = cumulativeBefore.estimatedUsd;
  const evaluation = evaluateBudgetStatus(cumulativeMeasuredUsd + cumulativeEstimatedUsd);

  await db
    .prepare(
      `INSERT INTO budget_ledger (experiment_id, recorded_at, repository, measured_usd, estimated_usd, cumulative_measured_usd, cumulative_estimated_usd, budget_status, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(experimentId, new Date().toISOString(), repository, measuredUsd, 0, cumulativeMeasuredUsd, cumulativeEstimatedUsd, evaluation.status, `wallMs=${wallMs}`)
    .run();

  return { status: evaluation.status, cumulativeMeasuredUsd, cumulativeEstimatedUsd };
}

interface OrchestrateResult {
  repository: string;
  ok: boolean;
  error?: string;
  telemetry?: RepoRunTelemetry & { attempts: number; retryReasons: string[] };
}

async function orchestrateOnce(request: Request, env: ValidationEnv): Promise<Response> {
  const contentLength = Number(request.headers.get("Content-Length") || "0");
  if (contentLength > MAX_SOURCE_ARCHIVE_BYTES + 64 * 1024) return json({ ok: false, error: "source-archive-too-large" }, 413);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, error: "multipart-form-required" }, 400);
  }
  const source = form.get("source");
  if (!(source instanceof File) || source.size < 1 || source.size > MAX_SOURCE_ARCHIVE_BYTES) {
    return json({ ok: false, error: "valid-source-archive-required" }, 400);
  }
  const experimentId = String(form.get("experimentId") || "");
  const corpusRaw = String(form.get("corpus") || "[]");
  // Clamp must stay BELOW the sandbox max_instances (10 in wrangler.research-sandbox.jsonc): the
  // platform frees instance slots lazily between sessions, so dispatching right at the container
  // ceiling reintroduces the "container stopped while the operation was pending" races (Gate 3
  // observed exactly this dispatching 5-of-5). Default = the clamp, so triggers that omit the
  // field dispatch at full width; pass a lower explicit value to throttle.
  const concurrency = Math.max(1, Math.min(8, Number.parseInt(String(form.get("concurrency") || "8"), 10) || 8));
  const batchSize = Math.max(1, Math.min(25, Number.parseInt(String(form.get("batchSize") || "10"), 10) || 10));
  if (!experimentId) return json({ ok: false, error: "experimentId required" }, 400);

  let corpus: CorpusEntry[];
  try {
    corpus = JSON.parse(corpusRaw) as CorpusEntry[];
    if (!Array.isArray(corpus) || corpus.length === 0) throw new Error("corpus must be a non-empty array");
  } catch (error: unknown) {
    return json({ ok: false, error: `invalid corpus: ${error instanceof Error ? error.message : String(error)}` }, 400);
  }
  for (const entry of corpus) validateShellSafeIdentifiers(entry.owner, entry.name, entry.language);

  const targetCommitDeltas = corpus.reduce((sum, e) => sum + e.targetCommits, 0);
  await ensureExperimentRun(env.RESEARCH_DB, experimentId, corpus.length, targetCommitDeltas, "stage0-full-experiment");

  const [stopRequested, repoStates, cumulativeBudget] = await Promise.all([
    queryStopRequested(env.RESEARCH_DB, experimentId),
    queryRepositoryStates(env.RESEARCH_DB, experimentId),
    queryCumulativeBudget(env.RESEARCH_DB, experimentId),
  ]);
  const budgetEval = evaluateBudgetStatus(cumulativeBudget.measuredUsd + cumulativeBudget.estimatedUsd);

  const plan = planOrchestratorDispatch(corpus, repoStates, budgetEval.status, stopRequested, concurrency, 3);

  for (const entry of plan.giveUpOn) {
    await markRepositoryFailed(env.RESEARCH_DB, experimentId, `${entry.owner}/${entry.name}`);
  }

  const results: OrchestrateResult[] = await Promise.all(
    plan.toDispatch.map(async (entry): Promise<OrchestrateResult> => {
      const repository = `${entry.owner}/${entry.name}`;
      await incrementOrchestratorAttempts(env.RESEARCH_DB, experimentId, repository);
      const start = Date.now();
      try {
        const { result, attempts, retryReasons } = await withContainerRetry((attempt) =>
          attemptRepoRun(env, entry.owner, entry.name, entry.language, entry.targetCommits, batchSize, experimentId, source, attempt),
        );
        const wallMs = Date.now() - start;
        // Budget telemetry is appended per-dispatch, immediately - not batched until the end of this
        // invocation - so a mid-invocation failure (this Worker itself crashing) doesn't lose spend
        // tracking for repositories that already finished within this same call.
        await appendBudgetLedgerRow(env.RESEARCH_DB, experimentId, repository, wallMs, await queryCumulativeBudget(env.RESEARCH_DB, experimentId));
        return { repository, ok: true, telemetry: { ...result, attempts, retryReasons } };
      } catch (error: unknown) {
        const wallMs = Date.now() - start;
        await appendBudgetLedgerRow(env.RESEARCH_DB, experimentId, repository, wallMs, await queryCumulativeBudget(env.RESEARCH_DB, experimentId));
        return { repository, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );

  const updatedStates = await queryRepositoryStates(env.RESEARCH_DB, experimentId);
  const progress = computeExperimentProgress(corpus, updatedStates);
  const finalBudget = await queryCumulativeBudget(env.RESEARCH_DB, experimentId);
  const finalBudgetEval = evaluateBudgetStatus(finalBudget.measuredUsd + finalBudget.estimatedUsd);

  return json({
    ok: true,
    experimentId,
    dispatchPlan: { dispatched: plan.toDispatch.map((e) => `${e.owner}/${e.name}`), reason: plan.reason, gaveUpOn: plan.giveUpOn.map((e) => `${e.owner}/${e.name}`) },
    results,
    progress,
    budget: { ...finalBudgetEval, measuredUsd: finalBudget.measuredUsd, estimatedUsd: finalBudget.estimatedUsd },
  });
}

async function stopExperiment(request: Request, env: ValidationEnv): Promise<Response> {
  let form: FormData | URLSearchParams;
  try {
    form = await request.formData();
  } catch {
    form = new URL(request.url).searchParams;
  }
  const experimentId = String(form.get("experimentId") || "");
  if (!experimentId) return json({ ok: false, error: "experimentId required" }, 400);
  const stopRequested = await setStopRequested(env.RESEARCH_DB, experimentId);
  if (!stopRequested) {
    // Should be unreachable given the upsert above always sets it - fail loudly rather than silently
    // report a stop that didn't actually happen, exactly the failure mode this fix closes.
    return json({ ok: false, experimentId, error: "stop_requested could not be verified after the write" }, 500);
  }
  return json({ ok: true, experimentId, stopRequested: true });
}

async function experimentStatus(request: Request, env: ValidationEnv): Promise<Response> {
  const experimentId = new URL(request.url).searchParams.get("experimentId") || "";
  if (!experimentId) return json({ ok: false, error: "experimentId required" }, 400);

  const [repoRows, deltaCount, budget, stopRequested] = await Promise.all([
    env.RESEARCH_DB.prepare("SELECT repository, status, commits_analyzed, orchestrator_attempts FROM repository_runs WHERE experiment_id = ? ORDER BY repository").bind(experimentId).all(),
    env.RESEARCH_DB.prepare("SELECT COUNT(*) as n FROM completed_deltas WHERE experiment_id = ?").bind(experimentId).all<{ n: number }>(),
    queryCumulativeBudget(env.RESEARCH_DB, experimentId),
    queryStopRequested(env.RESEARCH_DB, experimentId),
  ]);
  const budgetEval = evaluateBudgetStatus(budget.measuredUsd + budget.estimatedUsd);

  return json({
    ok: true,
    experimentId,
    repositories: repoRows.results,
    deltasRecordedUnderThisExperimentId: deltaCount.results[0]?.n ?? 0,
    budget: { ...budgetEval, measuredUsd: budget.measuredUsd, estimatedUsd: budget.estimatedUsd },
    stopRequested,
  });
}

// ============================================================================================
// Stage 1A forensic support (2026-08-21) - read-only scan over EXISTING Stage 0 R2 evidence.
// Does not touch Stage 0 evidence or D1 state; only reads. Server-side R2 gets are far faster
// than pulling 2000 individual objects via wrangler CLI (each CLI invocation has real process-
// startup overhead - see the Gate 4 nestjs-record-recovery precedent, which took several minutes
// for just 100 objects). Batches R2 reads to bound concurrent in-flight requests.
async function scanUnsafeMisses(request: Request, env: ValidationEnv): Promise<Response> {
  const keysResult = await env.RESEARCH_DB.prepare(
    "SELECT repository, r2_evidence_key FROM completed_deltas",
  ).bind().all<{ repository: string; r2_evidence_key: string }>();
  const rows = keysResult.results;

  const misses: unknown[] = [];
  let scanned = 0;
  let fetchErrors = 0;
  const BATCH = 40;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (row) => {
        try {
          const raw = await env.RESEARCH_BUCKET.get(row.r2_evidence_key);
          if (!raw) return { error: "missing", key: row.r2_evidence_key };
          const record = await raw.json<any>();
          return { record };
        } catch (error: unknown) {
          return { error: error instanceof Error ? error.message : String(error), key: row.r2_evidence_key };
        }
      }),
    );
    for (const r of results) {
      scanned++;
      if ("error" in r) { fetchErrors++; continue; }
      const rec = r.record;
      const unsafeTargets: string[] = rec.historicalUnsafeMissTargets ?? [];
      const pathUnsafeTargets: string[] = rec.historicalPathUnsafeMissTargets ?? [];
      if (unsafeTargets.length > 0 || pathUnsafeTargets.length > 0) {
        misses.push({
          repository: rec.repository,
          baseSha: rec.identity?.baseSha,
          headSha: rec.identity?.headSha,
          logicalDeltaKey: rec.identity?.logicalDeltaKey,
          fallback: rec.fallback,
          graphConfidence: rec.graphConfidence,
          testsTotal: rec.testsTotal,
          testsSelectedByPath: rec.testsSelectedByPath,
          testsSelectedByDiffci: rec.testsSelectedByDiffci,
          historicalEvidenceStatus: rec.historicalEvidenceStatus,
          historicalEvidenceReason: rec.historicalEvidenceReason,
          historicalFailedTargets: rec.historicalFailedTargets,
          historicalUnsafeMissTargets: unsafeTargets,
          historicalPathUnsafeMissTargets: pathUnsafeTargets,
          changedFiles: rec.gitDelta?.files ?? rec.identity?.gitDelta?.files,
          category: rec.category,
        });
      }
    }
  }

  return json({ ok: true, totalRows: rows.length, scanned, fetchErrors, diffciUnsafeMisses: misses.filter((m: any) => m.historicalUnsafeMissTargets.length > 0).length, pathUnsafeMisses: misses.filter((m: any) => m.historicalPathUnsafeMissTargets.length > 0).length, misses });
}

export default {
  async fetch(request: Request, env: ValidationEnv, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
    if (env.DIFFCI_RESEARCH_ENABLED !== "true") {
      return json({ ok: false, error: "diffci-research-sandbox disabled" }, 503);
    }
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "diffci-research-sandbox" });
    }
    if (request.method === "POST" && url.pathname === "/v1/validate") {
      if (!(await authorized(request, env.RESEARCH_DISPATCH_TOKEN))) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }
      return validate(request, env);
    }
    if (request.method === "POST" && url.pathname === "/v1/run-repo") {
      if (!(await authorized(request, env.RESEARCH_DISPATCH_TOKEN))) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }
      return runRepo(request, env);
    }
    if (request.method === "POST" && url.pathname === "/v1/orchestrate") {
      if (!(await authorized(request, env.RESEARCH_DISPATCH_TOKEN))) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }
      return orchestrateOnce(request, env);
    }
    if (request.method === "POST" && url.pathname === "/v1/stop") {
      if (!(await authorized(request, env.RESEARCH_DISPATCH_TOKEN))) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }
      return stopExperiment(request, env);
    }
    if (request.method === "GET" && url.pathname === "/v1/status") {
      if (!(await authorized(request, env.RESEARCH_DISPATCH_TOKEN))) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }
      return experimentStatus(request, env);
    }
    if (request.method === "POST" && url.pathname === "/v1/forensic/scan-unsafe-misses") {
      if (!(await authorized(request, env.RESEARCH_DISPATCH_TOKEN))) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }
      return scanUnsafeMisses(request, env);
    }
    if (request.method === "POST" && url.pathname === "/v1/forensic/graph-diagnose") {
      if (!(await authorized(request, env.RESEARCH_DISPATCH_TOKEN))) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }
      return forensicDiagnose(request, env);
    }
    if (request.method === "POST" && url.pathname === "/v1/forensic/runtime-benchmark") {
      if (!(await authorized(request, env.RESEARCH_DISPATCH_TOKEN))) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }
      return runtimeBenchmark(request, env);
    }
    if (request.method === "POST" && url.pathname === "/v1/shadow/enroll") {
      if (!(await authorized(request, env.RESEARCH_DISPATCH_TOKEN))) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }
      return shadowEnroll(request, env);
    }
    if (request.method === "POST" && url.pathname === "/v1/shadow/poll") {
      if (!(await authorized(request, env.RESEARCH_DISPATCH_TOKEN))) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }
      return shadowPoll(request, env);
    }
    if (request.method === "POST" && url.pathname === "/v1/shadow/reconcile") {
      if (!(await authorized(request, env.RESEARCH_DISPATCH_TOKEN))) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }
      return shadowReconcile(request, env);
    }
    if (request.method === "GET" && url.pathname === "/v1/shadow/status") {
      if (!(await authorized(request, env.RESEARCH_DISPATCH_TOKEN))) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }
      return shadowStatus(request, env);
    }
    if (request.method === "POST" && url.pathname === "/v1/shadow/webhook") {
      // No bearer auth - authenticated by GitHub's HMAC signature inside the handler.
      return shadowWebhook(request, env, ctx);
    }
    if (request.method === "POST" && url.pathname === "/v1/shadow/source") {
      if (!(await authorized(request, env.RESEARCH_DISPATCH_TOKEN))) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }
      return shadowSourceUpload(request, env);
    }
    if (request.method === "POST" && url.pathname === "/v1/shadow/cron-run") {
      if (!(await authorized(request, env.RESEARCH_DISPATCH_TOKEN))) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }
      return shadowCronRun(request, env);
    }
    if (request.method === "GET" && url.pathname === "/v1/shadow/cron-status") {
      if (!(await authorized(request, env.RESEARCH_DISPATCH_TOKEN))) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }
      return shadowCronStatus(request, env);
    }
    if (request.method === "GET" && url.pathname === "/v1/shadow/app-info") {
      if (!(await authorized(request, env.RESEARCH_DISPATCH_TOKEN))) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }
      return shadowAppInfo(env, url.searchParams.get("delivery") ?? undefined);
    }
    if (request.method === "GET" && url.pathname === "/v1/shadow/reconcile-diagnostics") {
      if (!(await authorized(request, env.RESEARCH_DISPATCH_TOKEN))) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }
      return shadowReconcileDiagnostics(request, env);
    }
    if (request.method === "GET" && url.pathname === "/v1/shadow/debug-baseline") {
      if (!(await authorized(request, env.RESEARCH_DISPATCH_TOKEN))) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }
      const repository = url.searchParams.get("repository") ?? "";
      const headSha = url.searchParams.get("headSha") ?? "";
      if (!repository || !headSha) return json({ ok: false, error: "repository and headSha query params required" }, 400);
      const token = await githubTokenForRepo(env, repository);
      const { fetchBaselineEvidence } = await import("../../shadow/github-baseline.js");
      try {
        const result = await fetchBaselineEvidence({ repository, headSha, token });
        return json({ ok: true, hadToken: !!token, status: result.status, fetchError: result.fetchError, completenessNotes: result.completenessNotes, fullRunsObserved: result.fullRunsObserved, jobCount: result.jobs.length });
      } catch (error: unknown) {
        return json({ ok: false, hadToken: !!token, error: error instanceof Error ? error.message : String(error) }, 500);
      }
    }
    return json({ ok: false, error: "not-found" }, 404);
  },

  /** Cron Trigger entry point (wrangler.research-sandbox.jsonc "triggers.crons") - the autonomous
   * shadow-validation heartbeat. Doubly gated: DIFFCI_RESEARCH_ENABLED guards the whole Worker,
   * SHADOW_CRON_ENABLED guards just this handler so autonomous polling can be switched off without
   * taking down the manually-driven research API. */
  async scheduled(_controller: { scheduledTime: number; cron: string }, env: ValidationEnv): Promise<void> {
    if (env.DIFFCI_RESEARCH_ENABLED !== "true" || env.SHADOW_CRON_ENABLED !== "true") {
      console.log("shadow-cron: disabled (DIFFCI_RESEARCH_ENABLED/SHADOW_CRON_ENABLED) - skipping scheduled run");
      return;
    }
    await runShadowCronOnce(makeShadowCronDeps(env), DEFAULT_SHADOW_CRON_CONFIG, "cron");

    // External Shadow Pilot M1 (2026-08-25): shadow-economics capture. Runs AFTER the poll/reconcile
    // heartbeat above and in its own try/catch, so a failure here can never take down autonomous shadow
    // validation - this is additive economics telemetry, not part of the safety methodology.
    //
    // Lives in this Worker specifically because it needs an authenticated GitHub credential, which only
    // this Worker has (githubTokenForRepo: least-privilege App installation token where the Shadow App is
    // actually installed, GITHUB_TOKEN for public repositories observed by poll only). It first ran in
    // the product Worker and failed on every commit against the unauthenticated 60 req/hour/IP limit.
    try {
      const boundary = makeD1ShadowReadBoundary(env.RESEARCH_DB as unknown as ShadowBoundaryD1);
      const economicsStore = makeD1ShadowEconomicsStore(env.RESEARCH_DB as unknown as ShadowEconomicsD1);
      const windowEnd = new Date();
      const windowStart = new Date(windowEnd.getTime() - 30 * 24 * 60 * 60 * 1000); // rolling 30-day window
      const economicsResult = await runShadowEconomicsCaptureSweep(
        {
          shadowBoundary: boundary,
          store: economicsStore,
          resolveToken: (repository) => githubTokenForRepo(env, repository),
        },
        windowStart.toISOString(),
        windowEnd.toISOString(),
        5, // bounded per sweep; authenticated now, but still deliberately conservative
      );
      console.log(`shadow-economics: ${JSON.stringify({ event: "shadow_economics.sweep_completed", ...economicsResult })}`);

      // M2 backfill: correct rows produced by a withdrawn estimator, and fill in rows left UNKNOWN when
      // their inputs were not yet usable. Bounded and self-terminating - once every row carries the
      // current estimator version this selects nothing and mutates nothing, so it costs one indexed query
      // per tick in steady state. Runs after capture so freshly-written rows are already current.
      const recomputeResult = await runShadowEconomicsRecompute({ store: economicsStore }, 50);
      if (recomputeResult.examined > 0) {
        console.log(`shadow-economics: ${JSON.stringify({ event: "shadow_economics.recompute_completed", ...recomputeResult })}`);
      }
    } catch (error: unknown) {
      console.log(`shadow-economics: sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};
