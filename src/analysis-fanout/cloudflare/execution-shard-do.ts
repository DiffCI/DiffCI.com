/**
 * AnalysisExecutionShard - execution validation, sibling to AnalysisShard (2026-08-24).
 *
 * Extension of the existing diffci-analysis-fanout Worker/deployment (same account, same R2 bucket,
 * same checksummed source tarball, same alarm-driven-DO pattern) - NOT a new Worker. Where
 * AnalysisShard runs the frozen DiffCI engine to produce a selection verdict, this DO takes an
 * ALREADY-PRODUCED verdict for ONE merge (an ExecutionSpec: repo, mergeSha, baseSha, DiffCI's own
 * selectedTestPaths) and actually installs and runs the TARGET repository's own test commands - full
 * suite and DiffCI-selected subset, both before and after one generic historical-regression mutation
 * (src/analysis-fanout/mutation.ts) - to measure real wall time and real failure-detection recall.
 *
 * Steps (each fits inside ONE bounded DO invocation - the four test-run steps below poll across
 * MULTIPLE invocations, exactly like AnalysisShard's `analyze` step, never a blocking loop within one):
 *   bootstrapping -> cloning -> deriving-selection -> installing -> pretest -> full-baseline
 *   -> selected-baseline -> mutating -> full-mutant -> selected-mutant -> reverting -> finalizing
 *   -> done | failed
 *
 * Never MODIFIES the frozen engine. `deriving-selection` INVOKES it (bootstrapped into /opt/diffci
 * exactly like AnalysisShard) when the caller didn't already supply a selection - see execution-types.ts.
 * A repository absent from repo-execution-profiles.ts cannot be executed here; the Worker rejects the
 * request before a container is ever provisioned.
 */
import { parseVitestJsonReport } from "../vitest-report.js";
import type { SandboxLike, R2BucketLike } from "../sandbox-like.js";
import type { ExecutionRecord, ExecutionSpec, ExecutionStep, RepoExecutionProfile, TestRunResult } from "../execution-types.js";
import { getRepoExecutionProfile } from "../repo-execution-profiles.js";
import { repoSlug } from "./analysis-shard-do.js";

export const SHAPE = "standard-4"; // installs are heavy (cal.com: 3582 packages, native builds, ~20 min)
/** How long the shard sleeps between poll alarms while a test-run process is in flight. */
export const POLL_MS = 20_000;
const SANDBOX_OPTS = { enableDefaultSession: false, keepAlive: false, sleepAfter: "15m", transport: "rpc" } as const;
const STATE_KEY = "execution";
const TERMINAL_PROCESS: ReadonlySet<string> = new Set(["completed", "failed", "killed", "error"]);
const TERMINAL_STEPS: ReadonlySet<ExecutionStep> = new Set(["done", "failed", "cancelled"]);

interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
}
interface DurableObjectState {
  storage: DurableObjectStorage;
  waitUntil(promise: Promise<unknown>): void;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SandboxNamespace = any;

export interface ExecutionEnv {
  ANALYSIS_SHARD_CONTAINER: SandboxNamespace;
  ANALYSIS_BUCKET: R2BucketLike;
}

export interface ExecutionStepDeps {
  sandbox: SandboxLike;
  bucket: R2BucketLike;
  profile: RepoExecutionProfile;
  now(): number;
}

export interface ExecutionStepResult {
  record: ExecutionRecord;
  /** Delay until the next alarm; `null` means the shard reached a terminal state. */
  nextAlarmDelayMs: number | null;
}

function argvToShellSafe(argv: string[]): string {
  // No untrusted input reaches this - argv comes from repo-execution-profiles.ts (a fixed, reviewed
  // config), the manifest's own recorded mergeSha/baseSha (hex only), and DiffCI's own selected test
  // paths (repo-relative posix paths from a frozen-engine result). Still quoted defensively.
  return argv.map((a) => (/[^A-Za-z0-9_.\/=:-]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ");
}

function packageManagerBin(profile: RepoExecutionProfile, forRun: boolean): string {
  if (profile.packageManager === "yarn") return "corepack yarn";
  if (profile.packageManager === "pnpm") return "corepack pnpm";
  return forRun ? "npm run" : "npm";
}

/**
 * Best-effort one-time corepack activation, prefixed onto the FIRST package-manager command of a
 * container's lifetime (2026-08-24: `docker.io/cloudflare/sandbox:0.12.5` ships Node without corepack's
 * shims pre-enabled - confirmed empirically, "corepack: command not found" on a real cal.com run). `npm
 * install -g corepack` is guaranteed to work (npm itself is already confirmed present - the engine
 * bootstrap step already ran `npm ci` in this same container) even on a Node version whose bundled
 * corepack was stripped from the image. Idempotent and harmless to repeat (`|| true` swallows a
 * subsequent "already enabled" failure); prepended, never a separate exec call, so it can never race
 * with or be skipped independently of the command it's guarding. No-op for npm (needs no corepack). */
function corepackSetupPrefix(profile: RepoExecutionProfile): string {
  if (profile.packageManager === "npm") return "";
  return "(corepack enable >/dev/null 2>&1 || npm install -g corepack --silent && corepack enable) >/dev/null 2>&1; ";
}

function workDir(record: ExecutionRecord): string {
  return `/workspace/${repoSlug(record.repository)}`;
}

function reportPath(reportName: string): string {
  return `/workspace/${reportName}.json`;
}

/** Builds the exact test-invocation argv (base command + reporter flags + trailing file filters), shared
 * between starting the process and reconstructing the `command` field once it completes. Pure function
 * of record/profile/inputs - safe to recompute across separate alarm invocations. */
function buildTestArgv(profile: RepoExecutionProfile, reportName: string, files: string[] | undefined): string[] {
  return [...profile.testArgv, ...profile.reporterArgv, `--outputFile=${reportPath(reportName)}`, ...(files ?? [])];
}

function buildTestCmd(dir: string, profile: RepoExecutionProfile, argv: string[]): string {
  const envPrefix = profile.testEnv ? Object.entries(profile.testEnv).map(([k, v]) => `${k}=${v}`).join(" ") + " " : "";
  return `cd ${dir} && ${corepackSetupPrefix(profile)}${envPrefix}${packageManagerBin(profile, true)} ${argvToShellSafe(argv)}`;
}

async function failExecution(record: ExecutionRecord, errorClass: string, lastError: string): Promise<ExecutionStepResult> {
  record.step = "failed";
  record.errorClass = errorClass;
  record.lastError = lastError;
  record.processId = undefined;
  record.processStartedAt = undefined;
  return { record, nextAlarmDelayMs: null };
}

/**
 * Bootstraps the frozen DiffCI engine itself into /opt/diffci - the SAME tarball/checksum/verify gate
 * AnalysisShard.bootstrap() uses (steps 2-4 of that function), so the `deriving-selection` step below
 * can invoke the unmodified frozen scripts/diffci-benchmark-external.ts against the target repo. Always
 * run (not only when a selection needs deriving): a single, uniform code path is simpler to reason
 * about than a conditional one, and the constant cost is small relative to the target repo's own
 * install/test steps.
 */
async function bootstrap(record: ExecutionRecord, deps: ExecutionStepDeps): Promise<ExecutionStepResult> {
  const { sandbox, bucket } = deps;
  try {
    const t0 = deps.now();
    await sandbox.exec("rm -rf /opt/diffci /workspace && mkdir -p /opt/diffci /workspace", { timeout: 30_000 });

    const tar = await bucket.get(record.tarballKey);
    if (!tar) return failExecution(record, "tarball-missing", `tarball missing in R2: ${record.tarballKey}`);
    await sandbox.writeFile("/opt/diffci-source.tgz", tar.body);
    await sandbox.exec("tar -xzf /opt/diffci-source.tgz -C /opt/diffci", { timeout: 120_000 });

    const sum = await sandbox.exec("sha256sum /opt/diffci-source.tgz", { timeout: 30_000 });
    const got = /^([0-9a-f]{64})/.exec(sum.stdout.trim());
    if (!got || got[1].toLowerCase() !== record.tarballSha256.toLowerCase()) {
      return failExecution(record, "tarball-corrupt", `post-transfer sha256 mismatch (${got ? got[1].slice(0, 12) : "none"} != ${record.tarballSha256.slice(0, 12)})`);
    }

    const npm = await sandbox.exec("cd /opt/diffci && npm ci --no-audit --no-fund", { timeout: 10 * 60_000 });
    if (!npm.success) {
      return failExecution(record, "bootstrap-failed", `npm ci exit ${npm.exitCode}: ${(npm.stdout + " " + npm.stderr).trim().slice(-1000)}`);
    }

    const frozen = await bucket.get(record.frozenManifestKey);
    if (!frozen) return failExecution(record, "frozen-manifest-missing", `frozen manifest missing in R2: ${record.frozenManifestKey}`);
    await sandbox.writeFile("/opt/frozen-manifest.json", await frozen.text());
    const verify = await sandbox.exec(
      "cd /opt/diffci && node docs/research/blind-baseline-2026-08-23/verify-frozen-engine.cjs --manifest /opt/frozen-manifest.json",
      { timeout: 120_000 },
    );
    if (!verify.success) {
      return failExecution(record, "engine-drift", `verify-frozen-engine exit ${verify.exitCode}: ${(verify.stdout + " " + verify.stderr).trim().slice(0, 1000)}`);
    }

    record.timings.bootstrapMs = deps.now() - t0;
    record.step = "cloning";
    return { record, nextAlarmDelayMs: 0 };
  } catch (err) {
    return failExecution(record, "bootstrap-failed", err instanceof Error ? err.message : String(err));
  }
}

async function clone(record: ExecutionRecord, deps: ExecutionStepDeps): Promise<ExecutionStepResult> {
  const { sandbox } = deps;
  try {
    const t0 = deps.now();
    const dir = workDir(record);
    // Full clone (not blob-less): install needs every blob anyway, and mutation reads the base
    // version of a file via `git show` - both need real object data, not a partial clone. A single
    // generous-timeout sandbox.exec (not startProcess+poll) matches AnalysisShard's own `clone()` step,
    // which already runs this shape of command in production at up to a 20-minute timeout.
    await sandbox.exec(`rm -rf ${dir} && git clone --quiet https://github.com/${record.repository}.git ${dir}`, { timeout: 20 * 60_000 });
    await sandbox.exec(`cd ${dir} && git checkout --quiet --force --detach ${record.mergeSha}`, { timeout: 5 * 60_000 });
    record.timings.cloneMs = deps.now() - t0;
    record.step = "deriving-selection";
    return { record, nextAlarmDelayMs: 0 };
  } catch (err) {
    return failExecution(record, "clone-failed", err instanceof Error ? err.message : String(err));
  }
}

/**
 * If the caller already supplied a selection (a prior analyze-mode row for this exact merge), pass
 * straight through - execution never recomputes a selection it was already given. Otherwise, derive one
 * fresh by invoking the frozen, UNMODIFIED scripts/diffci-benchmark-external.ts against the freshly-
 * cloned target repo, entirely inside this sandbox (never locally). Never fabricates: an unparseable or
 * `ok:false` result fails the execution rather than defaulting to an empty/guessed selection.
 */
async function deriveSelection(record: ExecutionRecord, deps: ExecutionStepDeps): Promise<ExecutionStepResult> {
  const { sandbox } = deps;
  if (record.selectedTestPaths && record.selectedTestPaths.length > 0) {
    record.step = "installing";
    return { record, nextAlarmDelayMs: 0 };
  }
  try {
    const dir = workDir(record);
    const t0 = deps.now();
    const cmd = `cd /opt/diffci && npx tsx scripts/diffci-benchmark-external.ts --repo ${dir} --base ${record.baseSha} --head ${record.mergeSha} --json`;
    const res = await sandbox.exec(cmd, { timeout: 10 * 60_000 });
    record.timings.deriveSelectionMs = deps.now() - t0;
    if (!res.success) {
      return failExecution(record, "derive-selection-failed", `diffci-benchmark-external exited ${res.exitCode}: ${(res.stdout + " " + res.stderr).trim().slice(-1000)}`);
    }
    let parsed: { summary?: { ok?: boolean; error?: string; totalTestsInGraph?: number }; full?: { affectedTests?: { path?: string }[] } };
    try {
      parsed = JSON.parse(res.stdout.trim().split("\n").pop() ?? "");
    } catch (err) {
      return failExecution(record, "derive-selection-failed", `unparseable diffci-benchmark-external output: ${err instanceof Error ? err.message : String(err)}: ${res.stdout.slice(-500)}`);
    }
    if (!parsed.summary?.ok) {
      return failExecution(record, "derive-selection-failed", `diffci-benchmark-external reported ok:false: ${parsed.summary?.error ?? "unknown error"}`);
    }
    const paths = (parsed.full?.affectedTests ?? []).map((t) => t.path).filter((p): p is string => typeof p === "string");
    record.selectedTestPaths = paths;
    record.totalTestsInGraph = parsed.summary.totalTestsInGraph ?? 0;
    record.analysisOverheadMs = record.timings.deriveSelectionMs;
    record.step = "installing";
    return { record, nextAlarmDelayMs: 0 };
  } catch (err) {
    return failExecution(record, "derive-selection-failed", err instanceof Error ? err.message : String(err));
  }
}

async function install(record: ExecutionRecord, deps: ExecutionStepDeps): Promise<ExecutionStepResult> {
  const { sandbox, profile } = deps;
  try {
    const dir = workDir(record);
    const t0 = deps.now();
    const cmd = `cd ${dir} && ${corepackSetupPrefix(profile)}${packageManagerBin(profile, false)} ${argvToShellSafe(profile.installArgv)}`;
    // A single generous-timeout sandbox.exec, matching AnalysisShard's `bootstrap()` npm-ci precedent
    // (10 min) scaled up for cal.com's heavier native-build install (observed ~20 min locally).
    const res = await sandbox.exec(cmd, { timeout: 25 * 60_000 });
    record.timings.installMs = deps.now() - t0;
    if (!res.success) {
      return failExecution(record, "install-failed", `install exited ${res.exitCode}: ${(res.stdout + " " + res.stderr).trim().slice(-1000)}`);
    }
    record.step = "pretest";
    return { record, nextAlarmDelayMs: 0 };
  } catch (err) {
    return failExecution(record, "install-failed", err instanceof Error ? err.message : String(err));
  }
}

async function pretest(record: ExecutionRecord, deps: ExecutionStepDeps): Promise<ExecutionStepResult> {
  const { sandbox, profile } = deps;
  try {
    const dir = workDir(record);
    const t0 = deps.now();
    for (const step of profile.pretestArgv) {
      const cmd = `cd ${dir} && ${corepackSetupPrefix(profile)}${packageManagerBin(profile, true)} ${argvToShellSafe(step)}`;
      const res = await sandbox.exec(cmd, { timeout: 5 * 60_000 });
      if (!res.success) {
        return failExecution(record, "pretest-failed", `pretest step [${step.join(" ")}] exited ${res.exitCode}: ${(res.stdout + " " + res.stderr).trim().slice(-1000)}`);
      }
    }
    record.timings.pretestMs = deps.now() - t0;
    record.step = "full-baseline";
    return { record, nextAlarmDelayMs: 0 };
  } catch (err) {
    return failExecution(record, "pretest-failed", err instanceof Error ? err.message : String(err));
  }
}

/** Config for one test-run step: which files to filter to (undefined = full suite), the JSON reporter's
 * output filename, which ExecutionStep to advance to, and where to store the resulting TestRunResult. */
interface TestRunStepConfig {
  files: string[] | undefined;
  reportName: string;
  nextStep: ExecutionStep;
  errorClass: string;
  applyResult(record: ExecutionRecord, result: TestRunResult): void;
}

/**
 * Advances ONE test-run step by exactly one bounded unit of work, mirroring AnalysisShard's `analyze()`
 * step precisely: first alarm starts the process (startProcess, never exec - a full suite run can run
 * well past a single-exec timeout) and returns POLL_MS; every later alarm polls the persisted
 * `record.processId` and either keeps waiting (POLL_MS again) or, once terminal, reads the JSON report,
 * builds a TestRunResult (never fabricating pass/fail when the report is missing), and advances.
 */
async function stepTestRun(record: ExecutionRecord, deps: ExecutionStepDeps, cfg: TestRunStepConfig): Promise<ExecutionStepResult> {
  const { sandbox, profile } = deps;
  const dir = workDir(record);
  const argv = buildTestArgv(profile, cfg.reportName, cfg.files);
  try {
    if (!record.processId) {
      const proc = await sandbox.startProcess(buildTestCmd(dir, profile, argv), { cwd: dir, autoCleanup: false });
      record.processId = proc.id;
      record.processStartedAt = deps.now();
      return { record, nextAlarmDelayMs: POLL_MS };
    }

    let status: string | undefined;
    let exitCode: number | undefined;
    try {
      const info = await sandbox.getProcess(record.processId);
      status = info?.status;
      exitCode = info?.exitCode;
    } catch {
      status = "error";
    }
    if (!(status && TERMINAL_PROCESS.has(status))) {
      return { record, nextAlarmDelayMs: POLL_MS };
    }

    let raw: string | undefined;
    try {
      raw = (await sandbox.readFile(reportPath(cfg.reportName))).content;
    } catch {
      raw = undefined;
    }
    const parsed = parseVitestJsonReport(raw);
    const result: TestRunResult = {
      command: argv,
      exitCode: exitCode ?? null,
      timedOut: status !== "completed" && status !== "failed",
      wallMs: deps.now() - (record.processStartedAt ?? deps.now()),
      files: parsed.parsed ? parsed.files : undefined,
      tests: parsed.parsed ? parsed.tests : undefined,
      passed: parsed.parsed ? parsed.passed : undefined,
      failed: parsed.parsed ? parsed.failed : undefined,
      failedTests: parsed.parsed ? parsed.failedTests : undefined,
    };
    cfg.applyResult(record, result);
    record.processId = undefined;
    record.processStartedAt = undefined;
    record.step = cfg.nextStep;
    return { record, nextAlarmDelayMs: 0 };
  } catch (err) {
    return failExecution(record, cfg.errorClass, err instanceof Error ? err.message : String(err));
  }
}

const fullBaseline = (record: ExecutionRecord, deps: ExecutionStepDeps): Promise<ExecutionStepResult> =>
  stepTestRun(record, deps, {
    files: undefined,
    reportName: "full-baseline",
    nextStep: "selected-baseline",
    errorClass: "full-baseline-failed",
    applyResult: (r, result) => { r.baseline = { full: result, selected: r.baseline?.selected as TestRunResult }; },
  });

const selectedBaseline = (record: ExecutionRecord, deps: ExecutionStepDeps): Promise<ExecutionStepResult> =>
  stepTestRun(record, deps, {
    // Guaranteed populated by the deriving-selection step before any test-run step is reachable.
    files: record.selectedTestPaths ?? [],
    reportName: "selected-baseline",
    nextStep: "mutating",
    errorClass: "selected-baseline-failed",
    applyResult: (r, result) => { r.baseline = { full: r.baseline!.full, selected: result }; },
  });

async function mutate(record: ExecutionRecord, deps: ExecutionStepDeps): Promise<ExecutionStepResult> {
  const { sandbox } = deps;
  try {
    const dir = workDir(record);
    // Same "whole-file revert to base" strategy as src/analysis-fanout/mutation.ts (see that file for
    // the full rationale), reimplemented here via sandbox.exec RPC calls instead of importing that
    // module directly: mutation.ts's selectFileToMutate() shells out synchronously with node:child_process
    // against a LOCAL filesystem/process, which has no meaning inside this DO - the actual git checkout
    // lives inside the remote sandbox container, reachable only through sandbox.exec/startProcess. The
    // change-detection query mutation.ts leaves to its caller is done here with a plain `git diff`.
    const changed = (await sandbox.exec(`cd ${dir} && git diff --name-only ${record.baseSha} ${record.mergeSha} -- . ':!*.test.ts' ':!*.spec.ts'`, { timeout: 30_000 })).stdout.trim().split(/\r?\n/).filter(Boolean);
    if (changed.length === 0) {
      record.mutation = { path: "", applied: false, skippedReason: "no non-test source file changed by this merge" };
      record.step = "reverting"; // nothing to mutate; skip straight to a no-op revert and finalize
      return { record, nextAlarmDelayMs: 0 };
    }
    let mutated: { path: string } | undefined;
    for (const path of changed) {
      const check = await sandbox.exec(`cd ${dir} && git cat-file -e ${record.baseSha}:${path} 2>/dev/null && echo yes || echo no`, { timeout: 15_000 });
      if (check.stdout.trim() === "yes") { mutated = { path }; break; }
    }
    if (!mutated) {
      record.mutation = { path: changed[0]!, applied: false, skippedReason: "no candidate file existed at base (all newly added)" };
      record.step = "reverting";
      return { record, nextAlarmDelayMs: 0 };
    }
    await sandbox.exec(`cd ${dir} && git show ${record.baseSha}:${mutated.path} > ${mutated.path}`, { timeout: 30_000 });
    record.mutation = { path: mutated.path, applied: true };
    record.step = "full-mutant";
    return { record, nextAlarmDelayMs: 0 };
  } catch (err) {
    return failExecution(record, "mutate-failed", err instanceof Error ? err.message : String(err));
  }
}

async function fullMutant(record: ExecutionRecord, deps: ExecutionStepDeps): Promise<ExecutionStepResult> {
  if (!record.mutation?.applied) { record.step = "reverting"; return { record, nextAlarmDelayMs: 0 }; }
  return stepTestRun(record, deps, {
    files: undefined,
    reportName: "full-mutant",
    nextStep: "selected-mutant",
    errorClass: "full-mutant-failed",
    applyResult: (r, result) => { r.mutant = { full: result, selected: r.mutant?.selected as TestRunResult }; },
  });
}

const selectedMutant = (record: ExecutionRecord, deps: ExecutionStepDeps): Promise<ExecutionStepResult> =>
  stepTestRun(record, deps, {
    files: record.selectedTestPaths,
    reportName: "selected-mutant",
    nextStep: "reverting",
    errorClass: "selected-mutant-failed",
    applyResult: (r, result) => { r.mutant = { full: r.mutant!.full, selected: result }; },
  });

async function revert(record: ExecutionRecord, deps: ExecutionStepDeps): Promise<ExecutionStepResult> {
  const { sandbox } = deps;
  try {
    if (record.mutation?.applied) {
      const dir = workDir(record);
      await sandbox.exec(`cd ${dir} && git checkout --quiet ${record.mergeSha} -- ${record.mutation.path}`, { timeout: 30_000 });
    }
    record.step = "finalizing";
    return { record, nextAlarmDelayMs: 0 };
  } catch (err) {
    // A failed revert does not invalidate the measurement already taken - record it but still finalize.
    record.lastError = `revert warning: ${err instanceof Error ? err.message : String(err)}`;
    record.step = "finalizing";
    return { record, nextAlarmDelayMs: 0 };
  }
}

function computeEconomicsAndRecall(record: ExecutionRecord): void {
  // analysisOverheadMs may be genuinely absent (neither caller-supplied nor derived, e.g. the shard
  // failed before deriving-selection) - economics stays undefined rather than defaulting it to 0, which
  // would misreport a zero-cost analysis instead of an unknown one.
  if (record.baseline && record.analysisOverheadMs !== undefined) {
    const fullTestMs = record.baseline.full.wallMs;
    const selectedTestMs = record.baseline.selected.wallMs;
    const grossSavedMs = fullTestMs - selectedTestMs;
    const netSavedMs = grossSavedMs - record.analysisOverheadMs;
    record.economics = {
      analysisOverheadMs: record.analysisOverheadMs,
      fullTestMs,
      selectedTestMs,
      grossSavedMs,
      netSavedMs,
      reductionPct: fullTestMs > 0 ? (netSavedMs / fullTestMs) * 100 : null,
    };
  }
  if (record.mutant && record.mutation?.applied) {
    const fullCaught = (record.mutant.full.failed ?? 0) > 0;
    const selectedCaught = (record.mutant.selected.failed ?? 0) > 0;
    record.recall = {
      fullSuiteCaughtMutant: fullCaught,
      selectedSuiteCaughtMutant: selectedCaught,
      recallMeasurable: fullCaught, // a full-suite miss makes recall unmeasurable, never a false "safe"
    };
  }
}

async function finalize(record: ExecutionRecord, deps: ExecutionStepDeps): Promise<ExecutionStepResult> {
  const { sandbox, bucket } = deps;
  try {
    computeEconomicsAndRecall(record);
    record.finishedAt = deps.now();
    const failed = record.errorClass !== undefined;
    record.step = failed ? "failed" : "done";
    await bucket.put(`runs/${record.runId}/${repoSlug(record.repository)}/execution-${record.mergeSha.slice(0, 10)}.json`, JSON.stringify(record, null, 2));
    return { record, nextAlarmDelayMs: null };
  } catch (err) {
    return failExecution(record, "finalize-failed", err instanceof Error ? err.message : String(err));
  } finally {
    try { await sandbox.destroy(); } catch { /* best-effort teardown; sleepAfter backstop still applies */ }
  }
}

/**
 * Advance an execution shard's state machine by exactly ONE bounded step. Returns the updated record
 * (the caller persists it) and the delay until the next alarm (or null at a terminal state) - the same
 * resumability contract as AnalysisShard's `stepShard`.
 */
export async function stepExecution(record: ExecutionRecord, deps: ExecutionStepDeps): Promise<ExecutionStepResult> {
  switch (record.step) {
    case "bootstrapping": return bootstrap(record, deps);
    case "cloning": return clone(record, deps);
    case "deriving-selection": return deriveSelection(record, deps);
    case "installing": return install(record, deps);
    case "pretest": return pretest(record, deps);
    case "full-baseline": return fullBaseline(record, deps);
    case "selected-baseline": return selectedBaseline(record, deps);
    case "mutating": return mutate(record, deps);
    case "full-mutant": return fullMutant(record, deps);
    case "selected-mutant": return selectedMutant(record, deps);
    case "reverting": return revert(record, deps);
    case "finalizing": return finalize(record, deps);
    default: return { record, nextAlarmDelayMs: null };
  }
}

export function seedExecutionRecord(spec: ExecutionSpec, shape: string, now: number): ExecutionRecord {
  return {
    runId: spec.runId,
    repository: spec.repository,
    mergeSha: spec.mergeSha,
    baseSha: spec.baseSha,
    prNumber: spec.prNumber,
    subject: spec.subject,
    step: "bootstrapping",
    shape,
    tarballKey: spec.tarballKey,
    tarballSha256: spec.tarballSha256,
    frozenManifestKey: spec.frozenManifestKey,
    engineChecksum: spec.engineChecksum,
    selectedTestPaths: spec.selectedTestPaths,
    totalTestsInGraph: spec.totalTestsInGraph,
    analysisOverheadMs: spec.analysisOverheadMs,
    timings: {},
    startedAt: now,
    heartbeatAt: now,
  };
}

/**
 * The AnalysisExecutionShard Durable Object: owns a Sandbox container by name and is driven entirely by
 * alarms, mirroring AnalysisShard exactly. `/start` persists the seed record and arms the first alarm,
 * then returns immediately - nothing here depends on a request lifetime.
 */
export class AnalysisExecutionShard {
  private readonly state: DurableObjectState;
  private readonly env: ExecutionEnv;

  constructor(state: DurableObjectState, env: ExecutionEnv) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/start") {
        const body = (await request.json()) as { spec: ExecutionSpec; shape: string };
        const profile = getRepoExecutionProfile(body.spec.repository);
        if (!profile) return Response.json({ ok: false, error: `not-configured: ${body.spec.repository}` }, { status: 400 });
        const existing = await this.state.storage.get<ExecutionRecord>(STATE_KEY);
        if (existing && !TERMINAL_STEPS.has(existing.step)) {
          // Idempotent start: an already-running shard must not be re-seeded (would re-clone/re-install).
          return Response.json({ ok: true, alreadyRunning: true, record: existing });
        }
        const record = seedExecutionRecord(body.spec, body.shape, Date.now());
        await this.state.storage.put(STATE_KEY, record);
        await this.state.storage.setAlarm(Date.now() + 1000);
        return Response.json({ ok: true, record });
      }
      if (request.method === "GET" && url.pathname === "/state") {
        const record = await this.state.storage.get<ExecutionRecord>(STATE_KEY);
        if (!record) return Response.json({ ok: false, error: "not-found" }, { status: 404 });
        return Response.json(record);
      }
      if (request.method === "POST" && url.pathname === "/cancel") {
        await this.state.storage.deleteAlarm();
        const rec = await this.state.storage.get<ExecutionRecord>(STATE_KEY);
        if (rec && !TERMINAL_STEPS.has(rec.step)) { rec.step = "cancelled"; await this.state.storage.put(STATE_KEY, rec); }
        return Response.json({ ok: true });
      }
      return Response.json({ ok: false, error: "not-found" }, { status: 404 });
    } catch (err) {
      return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
    }
  }

  async alarm(): Promise<void> {
    const record = await this.state.storage.get<ExecutionRecord>(STATE_KEY);
    if (!record || TERMINAL_STEPS.has(record.step)) return;

    // Re-obtain the container handle by name; the container (and any running process) persists across
    // alarms and evictions, exactly like AnalysisShard. `@cloudflare/sandbox` is imported lazily so the
    // pure state machine (`stepExecution` and its helpers) stays loadable under Node/tsx for tests.
    const { getSandbox } = await import("@cloudflare/sandbox");
    const sandbox: SandboxLike = getSandbox(this.env.ANALYSIS_SHARD_CONTAINER, `exec-${repoSlug(record.repository)}-${record.mergeSha.slice(0, 10)}`, SANDBOX_OPTS);
    const profile = getRepoExecutionProfile(record.repository);
    if (!profile) {
      record.step = "failed";
      record.errorClass = "not-configured";
      await this.state.storage.put(STATE_KEY, record);
      await this.state.storage.deleteAlarm();
      return;
    }
    const deps: ExecutionStepDeps = { sandbox, bucket: this.env.ANALYSIS_BUCKET, profile, now: () => Date.now() };
    record.heartbeatAt = Date.now();
    const { record: updated, nextAlarmDelayMs } = await stepExecution(record, deps);
    await this.state.storage.put(STATE_KEY, updated);
    if (nextAlarmDelayMs !== null) await this.state.storage.setAlarm(Date.now() + nextAlarmDelayMs);
    else await this.state.storage.deleteAlarm();
  }
}
