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
import type { DiagnosticCommandResult, ExecutionRecord, ExecutionSpec, ExecutionStep, ObservabilityStatus, RepoExecutionProfile, RuntimeSelectionEvidence, TestRunResult } from "../execution-types.js";
import { getRepoExecutionProfile } from "../repo-execution-profiles.js";
import { repoSlug } from "./analysis-shard-do.js";
import { decideActivation } from "../activation-gate.js";
import { decideBaselineSafety, decideFinalActivation, type BaselineFingerprint } from "../baseline-fingerprint-gate.js";

export const SHAPE = "standard-4"; // installs are heavy (cal.com: 3582 packages, native builds, ~20 min)
/** How long the shard sleeps between poll alarms while a test-run process is in flight. */
export const POLL_MS = 20_000;
/** Applies when a RepoExecutionProfile omits its own `maxTestRunMs` (2026-08-24 safeguard - see
 * RepoExecutionProfile.maxTestRunMs for the finding that motivated this). Deliberately generous as a
 * global fallback since normal duration varies enormously by repository; a profile should set its own
 * tighter value once real observations exist for that repository. */
export const DEFAULT_MAX_TEST_RUN_MS = 20 * 60_000;
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

/** CI-parity experiment user (2026-08-25) - see ExecutionSpec.runAsNonRoot. `docker.io/cloudflare/sandbox:
 * 0.12.5` ships with no unprivileged human-usable account (`/etc/passwd` has only root and a shell-less
 * `sync`), confirmed via a live diagnostic probe, so one is created fresh per run rather than assumed to
 * exist. UID/GID 1001 is a common real convention (matches e.g. GitHub's own `ubuntu`-image runner user),
 * not a byte-for-byte replica of deepseek-harness's actual CI UID - this experiment tests root-vs-non-root
 * POSIX permission-check behavior, not an exact runner fingerprint. */
const NON_ROOT_USER = "ciuser";
const NON_ROOT_UID = 1001;

/** Wraps a command to run as `NON_ROOT_USER` via `su -` (a LOGIN shell, so $HOME/$PATH resolve to the new
 * user's own values - pnpm/corepack need a real $HOME for their store/cache paths, which a plain `su -c`
 * without the login dash would leave pointed at root's). Single-quoted with POSIX-correct embedded-quote
 * escaping (`'` -> `'\''`) since the inner command already carries its own double-quoting from
 * `argvToShellSafe`. A no-op (returns `cmd` verbatim) when `runAsNonRoot` is falsy - every existing
 * profile/repository is completely unaffected unless a run opts in. */
function wrapNonRoot(cmd: string, runAsNonRoot: boolean | undefined): string {
  if (!runAsNonRoot) return cmd;
  return `su - ${NON_ROOT_USER} -c '${cmd.replace(/'/g, "'\\''")}'`;
}

/** Baseline-fingerprint identity (2026-08-25, hard-wired enforcement round). All four values are part of
 * the fingerprint STORE KEY (not just fields checked post-fetch) - a mismatch on any of them means the
 * fetch itself finds nothing (REFUSE_NO_FINGERPRINT), not a stale/wrong object that then has to be
 * detected by content comparison. `decideBaselineSafety` still re-verifies every field against the fetched
 * object's own content as defense-in-depth against a key-scheme bug. */
function environmentIdentityOf(record: Pick<ExecutionRecord, "runAsNonRoot">): string {
  return record.runAsNonRoot ? "nonroot" : "root";
}
function commandIdentityOf(profile: RepoExecutionProfile, record: Pick<ExecutionRecord, "testArgvOverride">): string {
  return (record.testArgvOverride ?? profile.testArgv).join(" ");
}
const TEST_FAMILY = "unit"; // the only family this harness executes end-to-end this mission - see repo-execution-profiles.ts
function fingerprintKey(repository: string, branch: string, baseSha: string, environmentIdentity: string, testFamily: string, commandIdentity: string): string {
  return `fingerprints/${repoSlug(repository)}/${encodeURIComponent(branch)}/${baseSha}/${environmentIdentity}__${testFamily}__${encodeURIComponent(commandIdentity)}.json`;
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

/**
 * The sandbox container's own name (2026-08-24 fix): MUST include `runId`, not just repo+mergeSha - two
 * different runs targeting the same merge (e.g. a diagnostic rerun of a prior run, or two concurrent
 * analyses) would otherwise land on the SAME underlying container and the SAME report file paths inside
 * it (`/workspace/full-baseline.json` etc.), silently corrupting or overwriting each other's evidence.
 * Truncated/sanitized since `runId` can be up to 128 chars and container names have practical limits;
 * collision risk from truncation is negligible for the runId patterns this harness actually generates.
 *
 * BOTH components bounded, not just runId (2026-08-25 fix, DeepSeek execution-validation mission): the
 * original truncation only capped `runId` at 24 chars, silently assuming `repoSlug(repository)` would
 * always stay short. `calcom__cal.diy` (13 chars) made that assumption invisible - the resulting id
 * (`exec-calcom__cal.diy-<sha10>-<runId>`, max 49 chars) stayed comfortably under container-name limits
 * for every Cal.com run this mission. `deepseek-ai__deepseek-harness` (30 chars) does not: with a
 * realistic runId (`deepseek-argprobe2`, 19 chars) the id landed at exactly 64 characters - one over the
 * classic 63-char DNS-label limit container/hostname naming conventions commonly enforce. Confirmed via
 * a real, reproducible failure: two independent deepseek-harness execution runs both stalled forever at
 * `step: "bootstrapping"` with `heartbeatAt` frozen at the exact seed timestamp (proving the DO's
 * `alarm()` handler never completed even once - it calls `getSandbox()`, which resolves the container by
 * this id, BEFORE the line that updates `heartbeatAt`), while a same-Worker, same-DO-class Cal.com control
 * probe started in between advanced through five real steps in under two minutes - isolating the failure
 * to something specific to the longer repository name, not a general Cloudflare alarm outage. Both
 * segments now bounded so the total is safely under 63 regardless of repository-name or runId length.
 */
export function sandboxContainerId(record: Pick<ExecutionRecord, "repository" | "mergeSha" | "runId">): string {
  const safeRunId = record.runId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 20);
  const safeRepoSlug = repoSlug(record.repository).slice(0, 20);
  return `exec-${safeRepoSlug}-${record.mergeSha.slice(0, 10)}-${safeRunId}`;
}

function reportPath(reportName: string): string {
  return `/workspace/${reportName}.json`;
}

/** Builds the exact test-invocation argv (base command + reporter flags + trailing file filters), shared
 * between starting the process and reconstructing the `command` field once it completes. Pure function
 * of record/profile/inputs - safe to recompute across separate alarm invocations.
 *
 * `--outputFile.<reporterName>=<path>` (dot-notation), not plain `--outputFile=<path>` (2026-08-24 fix):
 * general and repository-independent, not a cal.com-specific workaround - it targets the "json" reporter
 * by name regardless of how many OTHER reporters are also configured (repo-execution-profiles.ts may
 * list more than one, e.g. adding `--reporter=default` for human-readable console output alongside the
 * structured file), so it never depends on json being the only or the first reporter. */
function buildTestArgv(profile: RepoExecutionProfile, reportName: string, files: string[] | undefined, testArgvBase: string[]): string[] {
  return [...testArgvBase, ...profile.reporterArgv, `--outputFile.json=${reportPath(reportName)}`, ...(files ?? [])];
}

function buildTestCmd(dir: string, profile: RepoExecutionProfile, argv: string[], runAsNonRoot?: boolean): string {
  const envPrefix = profile.testEnv ? Object.entries(profile.testEnv).map(([k, v]) => `${k}=${v}`).join(" ") + " " : "";
  const testCmd = `cd ${dir} && ${envPrefix}${packageManagerBin(profile, true)} ${argvToShellSafe(argv)}`;
  // Same root/non-root split as install() (2026-08-25): corepackSetupPrefix's global activation stays
  // root, only the actual test invocation runs as NON_ROOT_USER. By the time a test-run step executes,
  // corepack was already activated during install() - this repeats the best-effort/idempotent check
  // (matches every OTHER test-run command's own prefix, unchanged for the non-experiment path) rather
  // than assuming it's still enabled from an earlier step in the same container's lifetime.
  return runAsNonRoot ? `${corepackSetupPrefix(profile)}${wrapNonRoot(testCmd, true)}` : `${corepackSetupPrefix(profile)}${testCmd}`;
}

/**
 * Marks the record failed and routes it through `finalizing` (2026-08-24 fix), not directly to the
 * terminal `failed` step. Every prior version of this function set `step: "failed"` directly with
 * `nextAlarmDelayMs: null` - which never reaches `finalize()`, meaning NO failure in this DO's history
 * was ever persisted to R2 (only retrievable via the live DO state while it still exists) and the
 * sandbox was never explicitly destroyed on a failure path (relying solely on the `sleepAfter` backstop).
 * Routing through `finalizing` gives every failure the same R2 persistence and sandbox cleanup a
 * successful run already gets, for free, via `finalize()`'s own existing logic.
 */
async function failExecution(record: ExecutionRecord, errorClass: string, lastError: string): Promise<ExecutionStepResult> {
  record.step = "finalizing";
  record.errorClass = errorClass;
  record.lastError = lastError;
  record.processId = undefined;
  record.processStartedAt = undefined;
  return { record, nextAlarmDelayMs: 0 };
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

    // CI-parity experiment (2026-08-25, see ExecutionSpec.runAsNonRoot): create the non-root user this
    // run's install/test commands will run as. `-m` creates the home directory `su -`'s login shell needs.
    // `|| true` makes user creation idempotent-safe (harmless if this container is somehow reused), though
    // every run in practice gets a fresh container per sandboxContainerId().
    if (record.runAsNonRoot) {
      const useradd = await sandbox.exec(`useradd -m -u ${NON_ROOT_UID} ${NON_ROOT_USER} || true`, { timeout: 30_000 });
      if (!useradd.success) {
        return failExecution(record, "nonroot-user-setup-failed", `useradd exit ${useradd.exitCode}: ${(useradd.stdout + " " + useradd.stderr).trim().slice(-500)}`);
      }
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
    if (record.runAsNonRoot) {
      // Ownership only, not the ACTING user, for git plumbing (2026-08-25): root can already read/write
      // any ownership regardless, so clone/checkout/later mutation-revert stay root for simplicity - only
      // the TEST PROCESS's own UID is the variable this experiment is testing. chown here so install and
      // the test runner (which DO run as NON_ROOT_USER) can read/write the tree at all.
      await sandbox.exec(`chown -R ${NON_ROOT_USER}:${NON_ROOT_USER} ${dir}`, { timeout: 60_000 });
      // reportPath() writes structured JSON reports to /workspace/<name>.json - ONE LEVEL ABOVE the
      // cloned repo dir, not inside it (2026-08-25 fix, found via a real run: the test process legitimately
      // completed as ciuser, but its own JSON reporter hit EACCES opening /workspace/full-baseline.json -
      // /workspace itself, created by root in bootstrap()'s mkdir, was never made writable by ciuser, only
      // the repo subdirectory was). Non-recursive - only the directory entry itself needs to be writable
      // for ciuser to create new files there; its other contents (this same repo clone) are already
      // correctly owned by the recursive chown above.
      await sandbox.exec(`chown ${NON_ROOT_USER}:${NON_ROOT_USER} /workspace`, { timeout: 15_000 });
      // git's "dubious ownership" protection (2026-08-25 fix, found via a real failed run - deriving-
      // selection's own git calls, run as root against a directory now owned by NON_ROOT_USER, refused
      // outright: "fatal: detected dubious ownership in repository", confirmed via a standalone
      // reproduction probe before this fix, not assumed). Root's later git operations here (mutate/revert)
      // need root's own global exception; a test/install step that happens to shell out to git needs
      // NON_ROOT_USER's own exception - both added, not just the one that actually failed.
      await sandbox.exec(`git config --global --add safe.directory ${dir}`, { timeout: 15_000 });
      await sandbox.exec(wrapNonRoot(`git config --global --add safe.directory ${dir}`, true), { timeout: 15_000 });
    }
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
    // CI-parity experiment (2026-08-25): corepack's global activation genuinely needs root (it may `npm
    // install -g`), so it always runs as root FIRST, standalone - separated from the actual install
    // command rather than baked into one su-wrapped string, since `su - user -c "root-thing && user-thing"`
    // would run BOTH halves as the non-root user, and the corepack half would then fail on write
    // permission to the global npm prefix.
    const installCmd = `cd ${dir} && ${packageManagerBin(profile, false)} ${argvToShellSafe(profile.installArgv)}`;
    const cmd = record.runAsNonRoot
      ? `${corepackSetupPrefix(profile)}${wrapNonRoot(installCmd, true)}`
      : `${corepackSetupPrefix(profile)}${installCmd}`;
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
    // Diagnostic-probe mode (2026-08-24): a run supplying diagnosticCommands skips the real
    // baseline/mutant measurement pipeline entirely - it exists to answer a narrower question
    // (argument-forwarding behavior) cheaply, not to measure economics.
    record.step = record.diagnosticCommands && record.diagnosticCommands.length > 0 ? "diagnosing" : "full-baseline";
    return { record, nextAlarmDelayMs: 0 };
  } catch (err) {
    return failExecution(record, "pretest-failed", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Runs each of `record.diagnosticCommands` in sequence, RAW - no argv construction, no reporter-flag
 * injection, exactly the literal string supplied. Each command is short-lived (a `--help`/`--list`/
 * invalid-flag probe, not a real test run), so a single bounded `sandbox.exec` per command is
 * appropriate (not startProcess+poll). Captures full stdout/stderr (not truncated to a tail - these
 * outputs are expected to be short) regardless of exit code, so a "this flag doesn't exist" error is
 * itself useful diagnostic evidence, not a failure to propagate.
 */
async function diagnose(record: ExecutionRecord, deps: ExecutionStepDeps): Promise<ExecutionStepResult> {
  const { sandbox } = deps;
  try {
    const dir = workDir(record);
    const results: DiagnosticCommandResult[] = [];
    for (const command of record.diagnosticCommands ?? []) {
      const t0 = deps.now();
      let res: { exitCode: number; stdout: string; stderr: string };
      try {
        // Generous timeout, not a tight one: most probe commands (--help/--list/invalid-flag) finish in
        // seconds, but a candidate command that turns out NOT to narrow execution could run the full
        // ~240s suite - that outcome is itself real diagnostic evidence and must be allowed to complete
        // and be captured, not killed early and misread as a hang.
        res = await sandbox.exec(`cd ${dir} && ${command}`, { timeout: 5 * 60_000 });
      } catch (err) {
        res = { exitCode: -1, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
      }
      results.push({ command, exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr, wallMs: deps.now() - t0 });
    }
    record.diagnosticResults = results;
    record.step = "finalizing";
    return { record, nextAlarmDelayMs: 0 };
  } catch (err) {
    return failExecution(record, "diagnose-failed", err instanceof Error ? err.message : String(err));
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
  const argv = buildTestArgv(profile, cfg.reportName, cfg.files, record.testArgvOverride ?? profile.testArgv);
  try {
    if (!record.processId) {
      const proc = await sandbox.startProcess(buildTestCmd(dir, profile, argv, record.runAsNonRoot), { cwd: dir, autoCleanup: false });
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
      // Max-step-duration safeguard (2026-08-24, cal.com --no-isolate full-suite anomaly finding): a
      // process still running past its profile's own maxTestRunMs is killed rather than polled forever
      // - see RepoExecutionProfile.maxTestRunMs and DEFAULT_MAX_TEST_RUN_MS.
      const maxMs = profile.maxTestRunMs ?? DEFAULT_MAX_TEST_RUN_MS;
      const elapsedMs = deps.now() - (record.processStartedAt ?? deps.now());
      if (elapsedMs > maxMs) {
        try {
          await sandbox.killProcess(record.processId);
        } catch {
          /* best-effort - still fail the execution below even if the kill itself couldn't be confirmed */
        }
        return failExecution(
          record,
          "step-timeout",
          `${cfg.reportName}: process exceeded maxTestRunMs (${maxMs}ms, elapsed ${elapsedMs}ms) - killed rather than polled indefinitely`,
        );
      }
      return { record, nextAlarmDelayMs: POLL_MS };
    }

    let raw: string | undefined;
    try {
      raw = (await sandbox.readFile(reportPath(cfg.reportName))).content;
    } catch {
      raw = undefined;
    }
    const parsed = parseVitestJsonReport(raw);
    // Captured regardless of report success - the audit trail for exactly this "structured report
    // missing/malformed" case (2026-08-24 finding: this was never captured before, on any test-run step).
    let stdoutTail: string | undefined;
    let stderrTail: string | undefined;
    try {
      const logs = await sandbox.getProcessLogs(record.processId);
      stdoutTail = logs.stdout?.slice(-8000);
      stderrTail = logs.stderr?.slice(-8000);
    } catch {
      /* best-effort - a log-retrieval failure must not fail the whole step */
    }
    // Empty-but-present content counts as missing, not malformed - a zero-byte file (no report was ever
    // written) is a different failure mode from "a report was written but isn't the expected shape",
    // and conflating the two would misdirect debugging effort.
    const observabilityStatus: ObservabilityStatus = parsed.parsed ? "complete" : raw === undefined || raw.trim() === "" ? "missing-report" : "malformed-report";
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
      stdoutTail,
      stderrTail,
      observabilityStatus,
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

/**
 * Execution-selection invariant (2026-08-24, see RuntimeSelectionEvidence): compares what DiffCI asked
 * the test runner to execute against what the runner's OWN structured report says it executed. A
 * requested file count is never proof of an executed file count - this is what actually distinguishes
 * them. `FRAMEWORK_EXPANSION_TOLERANCE` is a small, explainable slack (e.g. a shared setup/fixture file
 * a runner counts as its own "test file"); anything past it, in either direction, means the request was
 * not faithfully reflected in what ran and needs explanation, not a silent "close enough."
 */
const FRAMEWORK_EXPANSION_TOLERANCE = 3;

export function classifyRuntimeSelection(requestedTestFiles: string[], result: TestRunResult): RuntimeSelectionEvidence {
  if (result.observabilityStatus !== "complete" || result.files === undefined) {
    return {
      requestedTestFiles,
      executedTestFilesKnown: false,
      status: "UNMEASURABLE",
      explanation: `no structured report to compare against (observabilityStatus: ${result.observabilityStatus})`,
    };
  }
  const executed = result.files;
  const requested = requestedTestFiles.length;
  const diff = executed - requested;
  const evidence = { requestedTestFiles, executedTestFilesKnown: true, testFilesExecuted: executed, totalTestsExecuted: result.tests };
  if (diff === 0) {
    return { ...evidence, status: "HONORED_EXACTLY", explanation: `executed file count (${executed}) matches requested (${requested}) exactly` };
  }
  if (Math.abs(diff) <= FRAMEWORK_EXPANSION_TOLERANCE) {
    return { ...evidence, status: "HONORED_WITH_FRAMEWORK_EXPANSION", explanation: `executed ${executed} files vs ${requested} requested (Δ${diff > 0 ? "+" : ""}${diff}) - within framework-expansion tolerance` };
  }
  return {
    ...evidence,
    status: "IGNORED_OR_BROADENED",
    explanation: diff > 0
      ? `executed ${executed} files vs only ${requested} requested (Δ+${diff}) - the selection filter does not appear to have narrowed execution`
      : `executed only ${executed} files vs ${requested} requested (Δ${diff}) - fewer files ran than requested; check for a path/pattern mismatch between DiffCI's selected paths and what the test runner matched`,
  };
}

const selectedBaseline = (record: ExecutionRecord, deps: ExecutionStepDeps): Promise<ExecutionStepResult> =>
  stepTestRun(record, deps, {
    // Guaranteed populated by the deriving-selection step before any test-run step is reachable.
    files: record.selectedTestPaths ?? [],
    reportName: "selected-baseline",
    nextStep: "mutating",
    errorClass: "selected-baseline-failed",
    applyResult: (r, result) => {
      r.baseline = { full: r.baseline!.full, selected: result };
      r.runtimeSelection = classifyRuntimeSelection(r.selectedTestPaths ?? [], result);
    },
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
    // Pathspec exclusions (2026-08-25, two fixes during the DeepSeek execution-validation mission):
    //
    // Fix 1: the original list (`.test.ts`/`.spec.ts` only) let `git diff --name-only`'s alphabetical
    // ordering pick a DOCS file ahead of the real source change whenever a merge touched both - confirmed
    // on PR #2808 (deepseek-ai/deepseek-harness): its lexicographically-first non-`.test.ts`/`.spec.ts`
    // path was a `.i18n.yaml` translation file with no test coverage anywhere. Added test-family
    // (`.test.tsx`/`.spec.tsx`/`.e2e.ts`/`.snapshot.ts`) and docs (`.md`, `.i18n.yaml`) exclusions.
    //
    // Fix 2 (found immediately after, on the SAME PR #2808, via the canary run this pathspec was meant to
    // unblock): fix 1 deliberately left manifest/lockfile/config files unexcluded, reasoning "merges with
    // those triggers already fall back at the selection-engine level" - that reasoning was wrong. PR #2808
    // itself changes a NESTED workspace `package.json` (`packages/host/frontend-static/package.json`) and
    // is still `SAFE_TO_PROPOSE` (only a ROOT-level manifest/lockfile change triggers fallback, not a
    // per-package one) - `git diff --name-only`'s alphabetical order put that package.json before
    // `src/index.ts`, so the canary mutated a workspace manifest instead of the file the PR's own subject
    // and Report 03's already-predeclared mutation policy (committed BEFORE this bug was found) identified
    // as the real target. The mutated package.json's base content pinned different dependency versions,
    // breaking 16 tests scattered across totally unrelated packages (subagent-acp, terminal-bash,
    // storage-sqlite, ...) - a real recall "miss" that reflected an off-target mutation, not a genuine
    // selection failure. Report 03's own rule already said "exclude... manifests" - this was a bug in
    // implementing that rule, not a policy change made after seeing an inconvenient result.
    //
    // Neither fix reaches DiffCI's own full `changedFileCategories` classifier (still a generic heuristic,
    // not a port of that TypeScript-level classification) - documented as a known limitation, not silently
    // assumed complete.
    const changed = (await sandbox.exec(
      `cd ${dir} && git diff --name-only ${record.baseSha} ${record.mergeSha} -- . ` +
        `':!*.test.ts' ':!*.spec.ts' ':!*.test.tsx' ':!*.spec.tsx' ':!*.e2e.ts' ':!*.snapshot.ts' ` +
        `':!*.md' ':!*.i18n.yaml' ` +
        `':!package.json' ':!**/package.json' ':!pnpm-lock.yaml' ':!package-lock.json' ':!yarn.lock'`,
      { timeout: 30_000 },
    )).stdout.trim().split(/\r?\n/).filter(Boolean);
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

/**
 * Failures the mutant run has that the baseline run did NOT already have (2026-08-25 fix, DeepSeek
 * execution-validation mission). The original check was `(mutant.failed ?? 0) > 0` - a raw "any failure
 * present" test, which is a FALSE POSITIVE on any repository whose baseline itself has pre-existing or
 * flaky failures: deepseek-ai/deepseek-harness's real baseline consistently shows 16-18 such failures on
 * every run (confirmed across every execution this mission), so the raw check reported
 * `fullSuiteCaughtMutant: true` even on PR #2844's mutation, which an exact failedTests diff proved
 * caused ZERO new failures (one flaky pre-existing failure simply didn't reproduce that run - normal
 * variance, not a caught regression). Cal.com's baseline happened to be failure-free throughout this
 * mission's entire history, which is why this never surfaced there - it is a property of THIS repository
 * being exercised, not new code specific to it.
 *
 * Falls back to the raw count when a comparable baseline result genuinely is not available (analysis-only
 * test fixtures, or a run whose own baseline never completed) - preserves prior behavior exactly for
 * those cases rather than treating "no baseline to compare against" as "zero pre-existing failures".
 */
function newFailureCount(mutantResult: TestRunResult, baselineResult: TestRunResult | undefined): number {
  if (mutantResult.failedTests && baselineResult?.observabilityStatus === "complete" && baselineResult.failedTests) {
    const baselineFailures = new Set(baselineResult.failedTests);
    return mutantResult.failedTests.filter((t) => !baselineFailures.has(t)).length;
  }
  return mutantResult.failed ?? 0;
}

function computeEconomicsAndRecall(record: ExecutionRecord): void {
  // Economics is gated on the runtime-selection invariant (2026-08-24): a "gross time saved" number is
  // meaningless - worse, misleading - if the "selected" run didn't actually run only the selected tests.
  // Only HONORED_EXACTLY / HONORED_WITH_FRAMEWORK_EXPANSION are eligible; IGNORED_OR_BROADENED and
  // UNMEASURABLE must never produce a reported savings figure. analysisOverheadMs may also be genuinely
  // absent (e.g. the shard failed before deriving-selection) - economics stays undefined rather than
  // defaulting it to 0, which would misreport a zero-cost analysis instead of an unknown one.
  const selectionHonored = record.runtimeSelection?.status === "HONORED_EXACTLY" || record.runtimeSelection?.status === "HONORED_WITH_FRAMEWORK_EXPANSION";
  if (record.baseline && record.analysisOverheadMs !== undefined && selectionHonored) {
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
    // Never inferred from exitCode, and never treated as a definite "0 failures" when the report simply
    // didn't parse - those are different situations (a real pass vs. an unknown outcome).
    const fullObservable = record.mutant.full.observabilityStatus === "complete";
    const selectedObservable = record.mutant.selected.observabilityStatus === "complete";
    const fullCaught = fullObservable ? newFailureCount(record.mutant.full, record.baseline?.full) > 0 : undefined;
    const selectedCaught = selectedObservable ? newFailureCount(record.mutant.selected, record.baseline?.selected) > 0 : undefined;
    record.recall = {
      fullSuiteCaughtMutant: fullCaught ?? false,
      selectedSuiteCaughtMutant: selectedCaught ?? false,
      // Measurable only when the full suite's own report parsed AND genuinely shows a NEW failure - an
      // unparsed full-suite report makes recall unmeasurable, never a false "safe".
      recallMeasurable: fullObservable && fullCaught === true,
    };
  }
}

/**
 * Reads a stored BaselineFingerprint from R2, if one exists at the exact identity key. Never throws on a
 * missing/corrupt object - a fingerprint that can't be read is exactly the same as one that was never
 * written, from the safety gate's point of view (REFUSE_NO_FINGERPRINT), never a hard failure of the run
 * it's being consulted for.
 */
async function readFingerprint(bucket: R2BucketLike, key: string): Promise<BaselineFingerprint | undefined> {
  try {
    const obj = await bucket.get(key);
    if (!obj) return undefined;
    return JSON.parse(await obj.text()) as BaselineFingerprint;
  } catch {
    return undefined;
  }
}

/**
 * Hard-wired baseline-fingerprint enforcement (2026-08-25) - runs inside `finalize()`, the one place every
 * execution path (real merge run or base-SHA control run) already converges, so there is no separate
 * "did the caller remember to check the gate" step to skip. Two roles, mutually exclusive per run:
 *
 *   - A base-SHA CONTROL run (`record.mergeSha === record.baseSha`, exactly the shape Reports 12/14 used
 *     manually) with a complete full-baseline observation WRITES a fresh fingerprint - this is how a
 *     trusted fingerprint comes to exist at all, automatically, from the same mechanism this mission
 *     already proved out, not a separate manual step.
 *   - A real merge run READS whatever fingerprint exists at its own identity key and computes the full
 *     `decideFinalActivation` verdict, persisted on the record as `activationDecision` - this IS the
 *     enforcement: the decision is computed and stored for every real run, unconditionally, not only when
 *     a caller happens to ask for it.
 *
 * Never throws - a fingerprint-store failure (read or write) degrades to "no fingerprint," the same
 * conservative default as one never having been written, rather than failing the whole execution over a
 * concern this run's own core measurement doesn't depend on.
 */
async function applyBaselineFingerprintGate(record: ExecutionRecord, deps: ExecutionStepDeps): Promise<void> {
  const { bucket, profile, now } = deps;
  const branch = record.branch ?? "unknown";
  const environmentIdentity = environmentIdentityOf(record);
  const commandIdentity = commandIdentityOf(profile, record);
  const key = fingerprintKey(record.repository, branch, record.baseSha, environmentIdentity, TEST_FAMILY, commandIdentity);

  if (record.mergeSha === record.baseSha) {
    // Base-SHA control run: persist what THIS run itself observed, if it observed anything usable.
    if (record.baseline?.full?.observabilityStatus === "complete") {
      const fingerprint: BaselineFingerprint = {
        repository: record.repository,
        branch,
        baseSha: record.baseSha,
        environmentIdentity,
        testFamily: TEST_FAMILY,
        commandIdentity,
        knownFailures: record.baseline.full.failedTests ?? [],
        establishedAtMs: now(),
      };
      try {
        await bucket.put(key, JSON.stringify(fingerprint, null, 2));
        record.fingerprintPersisted = { key, knownFailureCount: fingerprint.knownFailures.length };
      } catch {
        /* best-effort - a failed write just means the next real run sees REFUSE_NO_FINGERPRINT, not a hard failure of this control run */
      }
    }
    return;
  }

  // Real merge run: read, decide, and record - unconditionally, not only on request.
  const fingerprint = await readFingerprint(bucket, key);
  const baselineSafety = decideBaselineSafety({
    repository: record.repository,
    branch,
    currentBaseSha: record.baseSha,
    environmentIdentity,
    testFamily: TEST_FAMILY,
    commandIdentity,
    fingerprint,
    maxFingerprintAgeMs: 7 * 24 * 3_600_000, // 7 days - provisional, not yet tuned against real repository drift rates
    nowMs: now(),
  });

  const selectionSafe = record.runtimeSelection?.status === "HONORED_EXACTLY" || record.runtimeSelection?.status === "HONORED_WITH_FRAMEWORK_EXPANSION";
  // Reuses the EXISTING economic gate (activation-gate.ts) rather than a second, inconsistent economics
  // check - single-sample (this one run), so its own lowConfidence flag applies exactly as it does
  // everywhere else this module is used in this mission.
  const economics = record.baseline && record.analysisOverheadMs !== undefined
    ? decideActivation({
        correctnessSafe: selectionSafe,
        samples: [{ fullMs: record.baseline.full.wallMs, selectedMs: record.baseline.selected.wallMs }],
        analysisOverheadMs: record.analysisOverheadMs,
        executionPlanningOverheadMs: 0,
        uncertaintyMarginFraction: 0.05,
      })
    : undefined;

  const fullObservedFailures = record.baseline?.full?.observabilityStatus === "complete" ? record.baseline.full.failedTests : undefined;
  const selectedObservedFailures = record.baseline?.selected?.observabilityStatus === "complete" ? (record.baseline.selected.failedTests ?? []) : [];

  const finalActivation = decideFinalActivation({
    selectionSafe,
    economicsBeneficial: economics?.economicallyBeneficial ?? false,
    baselineSafety,
    fingerprint,
    fullObservedFailures,
    selectedObservedFailures,
  });

  record.activationDecision = {
    branch,
    environmentIdentity,
    testFamily: TEST_FAMILY,
    commandIdentity,
    fingerprintKey: key,
    fingerprintFound: fingerprint !== undefined,
    baselineSafety,
    economicsBeneficial: economics?.economicallyBeneficial ?? false,
    finalActivation,
  };
}

async function finalize(record: ExecutionRecord, deps: ExecutionStepDeps): Promise<ExecutionStepResult> {
  const { sandbox, bucket } = deps;
  try {
    computeEconomicsAndRecall(record);
    await applyBaselineFingerprintGate(record, deps);
    record.finishedAt = deps.now();
    const failed = record.errorClass !== undefined;
    record.step = failed ? "failed" : "done";
    await bucket.put(`runs/${record.runId}/${repoSlug(record.repository)}/execution-${record.mergeSha.slice(0, 10)}.json`, JSON.stringify(record, null, 2));
    return { record, nextAlarmDelayMs: null };
  } catch (err) {
    // Deliberately NOT failExecution() here (which now routes to "finalizing", see its own doc comment) -
    // finalize() is the terminal step; routing its own failure back to "finalizing" would loop forever
    // on a persistent error (e.g. R2 genuinely unreachable). Goes straight to the "failed" terminal
    // state instead - the record itself is still returned and persisted by the DO's own storage.put()
    // (a step's return value is always saved to DO storage regardless of the R2 write's own success),
    // it just won't have a corresponding R2 object if the R2 write itself was what failed.
    record.step = "failed";
    record.errorClass = "finalize-failed";
    record.lastError = err instanceof Error ? err.message : String(err);
    return { record, nextAlarmDelayMs: null };
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
    case "diagnosing": return diagnose(record, deps);
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
    testArgvOverride: spec.testArgvOverride,
    diagnosticCommands: spec.diagnosticCommands,
    runAsNonRoot: spec.runAsNonRoot,
    branch: spec.branch,
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
    const sandbox: SandboxLike = getSandbox(this.env.ANALYSIS_SHARD_CONTAINER, sandboxContainerId(record), SANDBOX_OPTS);
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
