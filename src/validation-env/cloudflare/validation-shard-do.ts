/**
 * ValidationShard - the canonical Linux validation environment (2026-08-28).
 *
 * WHY THIS EXISTS. The dogfood corpus qualified both single-package libraries it tried and refused both
 * monorepos, and neither refusal was a property of the repository: `zod` needed a `pnpm` this harness
 * did not put on PATH, `TanStack/query` needed git history a shallow clone did not have. Both are
 * properties of a Windows developer host. The bias pointed exactly the wrong way, because monorepos are
 * where the graph-explosion question actually lives, so safety evidence was accumulating only from the
 * class of repository where the question matters least.
 *
 * The intended fix was a pinned `node:22.14.0-bookworm-slim` image (ops/validation-env/Dockerfile).
 * Docker Desktop on this host never started, so that image has never been built. This DO reaches the
 * same goal through infrastructure that is already proven in this account: the same
 * `cloudflare/sandbox:0.12.5` container the analysis-fanout execution shards already use to clone,
 * install and test real repositories - including cal.com, whose install alone runs about twenty minutes.
 * It needs no local Docker daemon, which is precisely the constraint that blocked the original plan.
 *
 * WHAT IT RUNS. The dogfood harness, unmodified, in two passes: `dogfood-observe` then `dogfood-mutate`.
 * Both passes are necessary. `dogfood-mutate` reads each candidate's observation report from disk and
 * SILENTLY SKIPS any candidate whose report is missing, so a mutation pass run against a fresh container
 * with no prior observation does not fail - it reports zero candidates and produces a clean, empty,
 * entirely meaningless funnel. Running observe first is what makes the funnel real.
 *
 * ALARM DISCIPLINE. Every long step starts a background process on one invocation and polls it on later
 * ones. No step blocks inside a single invocation waiting for a multi-hour harness to finish, which is
 * the rule the analysis-shard work established the hard way.
 *
 * WHAT THIS DOES NOT DO. It does not change DiffCI, the engine, or the harness. The Linux phase is for
 * establishing whether the evidence reproduces, not for improving the thing being measured.
 */
import type { R2BucketLike, SandboxLike } from "../../analysis-fanout/sandbox-like.js";
import {
  JOB_CORPUS_PATH,
  OBSERVED_CORPUS_PATH,
  PINNED_CLONE,
  RUNS_DIR,
  SCRATCH_ROOT,
  WORKSPACE,
  buildJobCorpus,
  getValidationJob,
  isPinnedSha,
  isRepositorySlug,
  mutateArgv,
  observeArgv,
  type ValidationJob,
} from "../validation-jobs.js";

/** Installs are heavy and the harness runs whole test suites; matches the execution shard's shape. */
export const SHAPE = "standard-4";
/** How long the shard sleeps between polls while the harness is running. */
export const POLL_MS = 30_000;

const STATE_KEY = "validation-record";
const TERMINAL_PROCESS: ReadonlySet<string> = new Set(["completed", "failed", "killed", "error"]);
const TERMINAL_STEPS: ReadonlySet<string> = new Set(["done", "failed", "cancelled"]);
const SANDBOX_OPTS = { enableDefaultSession: false, keepAlive: false, sleepAfter: "20m", transport: "rpc" } as const;

/** Where the harness lives inside the container. */
const DIFFCI_DIR = "/opt/diffci";
const AGENT_DIR = `${DIFFCI_DIR}/dist-agent`;
const SOURCE_TGZ = "/opt/diffci-source.tgz";
const INTEGRITY_SCRIPT = "/opt/agent-integrity.cjs";

export type ValidationStep =
  | "bootstrapping"
  | "preparing"
  | "observing"
  | "locating"
  | "mutating"
  | "collecting"
  | "done"
  | "failed"
  | "cancelled";

export interface ValidationRecord {
  runId: string;
  jobId: string;
  step: ValidationStep;
  startedAt: number;
  heartbeatAt: number;
  /** R2 keys, verified by checksum before anything runs. */
  sourceTarballKey: string;
  sourceTarballSha256: string;
  agentTarballKey: string;
  /** Identity of the environment that produced the evidence - the whole point of a canonical image. */
  environment?: {
    image: string;
    node?: string;
    npm?: string;
    git?: string;
    uname?: string;
    osRelease?: string;
    /** The agent's own sha512, measured in-container and matched against the job's expectation. */
    agentIntegrity?: string;
  };
  processId?: string;
  processStartedAt?: number;
  scratchDir?: string;
  clonePath?: string;
  runDirName?: string;
  resultKeys?: string[];
  observedRows?: number;
  errorClass?: string;
  error?: string;
  logs?: { observe?: string; mutate?: string };
  timings: Record<string, number>;
}

export interface ValidationStepDeps {
  sandbox: SandboxLike;
  bucket: R2BucketLike;
  job: ValidationJob;
  now: () => number;
}

export interface ValidationStepResult {
  record: ValidationRecord;
  /** null ends the alarm chain. */
  nextAlarmDelayMs: number | null;
}

/** Single-quote for a POSIX shell. `sandbox.exec` runs through a shell, so nothing goes in raw. */
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function fail(record: ValidationRecord, errorClass: string, error: string): ValidationStepResult {
  record.step = "failed";
  record.errorClass = errorClass;
  record.error = error.slice(0, 4000);
  return { record, nextAlarmDelayMs: null };
}

function tail(result: { stdout?: string; stderr?: string }, n = 1500): string {
  return `${result.stdout ?? ""} ${result.stderr ?? ""}`.trim().slice(-n);
}

export function seedValidationRecord(
  runId: string,
  job: ValidationJob,
  keys: { sourceTarballKey: string; sourceTarballSha256: string; agentTarballKey: string },
  now: number,
): ValidationRecord {
  return {
    runId,
    jobId: job.id,
    step: "bootstrapping",
    startedAt: now,
    heartbeatAt: now,
    sourceTarballKey: keys.sourceTarballKey,
    sourceTarballSha256: keys.sourceTarballSha256,
    agentTarballKey: keys.agentTarballKey,
    timings: {},
  };
}

/**
 * Extract DiffCI, install its dependencies, place the agent tarball, and establish that the agent in
 * this container is byte-identical to the one that produced the evidence being reproduced.
 *
 * The agent check is not ceremony. "Same agent digest" is one of the four things held constant in a
 * reproduction experiment; if it silently differed, a classification difference would be attributed to
 * the operating system when it actually came from a rebuilt bundle.
 */
async function bootstrap(record: ValidationRecord, deps: ValidationStepDeps): Promise<ValidationStepResult> {
  const { sandbox, bucket, job } = deps;
  const t0 = deps.now();
  try {
    await sandbox.exec(`rm -rf ${DIFFCI_DIR} ${WORKSPACE} && mkdir -p ${DIFFCI_DIR} ${WORKSPACE} ${SCRATCH_ROOT} ${RUNS_DIR} ${AGENT_DIR}`, { timeout: 60_000 });

    const source = await bucket.get(record.sourceTarballKey);
    if (!source) return fail(record, "source-missing", `source tarball missing in R2: ${record.sourceTarballKey}`);
    await sandbox.writeFile(SOURCE_TGZ, source.body);

    // Content-addressed in R2, but verified here anyway: the tarball travels through a stream write into
    // a container, and a truncated write would otherwise surface as a confusing npm error much later.
    const sum = await sandbox.exec(`sha256sum ${SOURCE_TGZ} | cut -d' ' -f1`, { timeout: 60_000 });
    const observed = sum.stdout.trim();
    if (observed !== record.sourceTarballSha256) {
      return fail(record, "source-checksum-mismatch", `expected ${record.sourceTarballSha256}, container computed ${observed}`);
    }

    const extract = await sandbox.exec(`tar -xzf ${SOURCE_TGZ} -C ${DIFFCI_DIR}`, { timeout: 120_000 });
    if (!extract.success) return fail(record, "source-extraction-failed", tail(extract));

    // Documented to ship git/node/npm, but verified rather than assumed, and self-healed if an image
    // revision drops one - failing here makes the cause obvious instead of surfacing mid-harness.
    let tools = await sandbox.exec("git --version && node --version && npm --version", { timeout: 20_000 });
    if (!tools.success) {
      await sandbox.exec(
        "(command -v apt-get >/dev/null && apt-get update && apt-get install -y git) || (command -v apk >/dev/null && apk add --no-cache git) || true",
        { timeout: 180_000 },
      );
      tools = await sandbox.exec("git --version && node --version && npm --version", { timeout: 20_000 });
      if (!tools.success) return fail(record, "toolchain-missing", tail(tools));
    }

    const agent = await bucket.get(record.agentTarballKey);
    if (!agent) return fail(record, "agent-missing", `agent tarball missing in R2: ${record.agentTarballKey}`);
    // `installAgent()` requires exactly one .tgz in dist-agent, so the directory is cleared first: a
    // leftover tarball from an earlier job would make the harness refuse to start.
    await sandbox.exec(`rm -f ${AGENT_DIR}/*.tgz`, { timeout: 30_000 });
    await sandbox.writeFile(`${AGENT_DIR}/agent.tgz`, agent.body);

    // Written as a file rather than passed as `node -e`, to keep quoting out of the shell entirely.
    await sandbox.writeFile(
      INTEGRITY_SCRIPT,
      [
        "const c = require('node:crypto');",
        "const f = require('node:fs');",
        `process.stdout.write('sha512-' + c.createHash('sha512').update(f.readFileSync('${AGENT_DIR}/agent.tgz')).digest('base64'));`,
      ].join("\n"),
    );
    const integrity = await sandbox.exec(`node ${INTEGRITY_SCRIPT}`, { timeout: 60_000 });
    const agentIntegrity = integrity.stdout.trim();
    if (agentIntegrity !== job.expectedAgentIntegrity) {
      return fail(
        record,
        "agent-integrity-mismatch",
        `job ${job.id} expects ${job.expectedAgentIntegrity}, container has ${agentIntegrity}`,
      );
    }

    const env = await sandbox.exec("node --version; npm --version; git --version; uname -a; (cat /etc/os-release 2>/dev/null | head -3) || true", { timeout: 30_000 });
    const lines = env.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    record.environment = {
      image: "docker.io/cloudflare/sandbox:0.12.5",
      node: lines[0],
      npm: lines[1],
      git: lines[2],
      uname: lines[3],
      osRelease: lines.slice(4).join(" "),
      agentIntegrity,
    };

    const npmCi = await sandbox.exec(`cd ${DIFFCI_DIR} && npm ci --no-audit --no-fund`, { timeout: 15 * 60_000 });
    if (!npmCi.success) return fail(record, "npm-ci-failed", tail(npmCi));

    record.timings.bootstrapMs = deps.now() - t0;
    record.step = "preparing";
    return { record, nextAlarmDelayMs: 0 };
  } catch (err) {
    return fail(record, "bootstrap-failed", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Clone the target and pin it, then write the corpus definition that points at the pinned clone.
 *
 * The reset to a local branch is what fixes the observed history. `dogfood-observe` runs `git log` at
 * HEAD, so a clone of live `main` observes whatever landed upstream that morning and the resulting
 * funnel is not comparable to the frozen one. A branch (not a detached HEAD) is used because
 * `materialise()` re-clones this path, and cloning a repository whose HEAD is detached does not reliably
 * reproduce that checkout.
 */
async function prepare(record: ValidationRecord, deps: ValidationStepDeps): Promise<ValidationStepResult> {
  const { sandbox, job } = deps;
  const t0 = deps.now();
  try {
    if (!isRepositorySlug(job.repository)) return fail(record, "invalid-repository", job.repository);
    if (!isPinnedSha(job.pinnedHeadSha)) return fail(record, "invalid-pinned-sha", job.pinnedHeadSha);

    const clone = await sandbox.exec(
      `rm -rf ${PINNED_CLONE} && git clone --quiet https://github.com/${job.repository}.git ${PINNED_CLONE}`,
      { timeout: 20 * 60_000 },
    );
    if (!clone.success) return fail(record, "clone-failed", tail(clone));

    const pin = await sandbox.exec(`cd ${PINNED_CLONE} && git checkout -B diffci-validation ${job.pinnedHeadSha}`, { timeout: 5 * 60_000 });
    if (!pin.success) return fail(record, "pin-failed", `could not pin ${job.repository} at ${job.pinnedHeadSha}: ${tail(pin)}`);

    await sandbox.writeFile(JOB_CORPUS_PATH, JSON.stringify(buildJobCorpus(job), null, 2));

    record.timings.prepareMs = deps.now() - t0;
    record.step = "observing";
    return { record, nextAlarmDelayMs: 0 };
  } catch (err) {
    return fail(record, "prepare-failed", err instanceof Error ? err.message : String(err));
  }
}

/** Start-or-poll a harness pass. Never blocks inside one invocation. */
async function runHarnessPass(
  record: ValidationRecord,
  deps: ValidationStepDeps,
  argv: string[],
  label: "observe" | "mutate",
  onComplete: (record: ValidationRecord) => ValidationStepResult,
): Promise<ValidationStepResult> {
  const { sandbox, job } = deps;
  try {
    if (!record.processId) {
      // TMPDIR is what makes the harness's own mkdtemp scratch directory discoverable afterwards; the
      // mutation pass needs the clone and reports the observation pass created inside it.
      const cmd = `cd ${DIFFCI_DIR} && TMPDIR=${SCRATCH_ROOT} npm ${argv.map(shq).join(" ")}`;
      const proc = await sandbox.startProcess(cmd, { cwd: DIFFCI_DIR, autoCleanup: false });
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
      const elapsed = deps.now() - (record.processStartedAt ?? deps.now());
      if (elapsed > job.maxRunMs) {
        try {
          await sandbox.killProcess(record.processId);
        } catch {
          /* best-effort; the run fails below regardless */
        }
        return fail(record, "run-timeout", `${label} exceeded maxRunMs (${job.maxRunMs}ms, elapsed ${elapsed}ms) - killed rather than polled indefinitely`);
      }
      return { record, nextAlarmDelayMs: POLL_MS };
    }

    try {
      const logs = await sandbox.getProcessLogs(record.processId);
      record.logs = { ...(record.logs ?? {}), [label]: `${logs.stdout ?? ""}\n${logs.stderr ?? ""}`.slice(-12_000) };
    } catch {
      /* logs are diagnostic, not load-bearing */
    }

    record.processId = undefined;
    record.processStartedAt = undefined;

    if (status !== "completed" || (exitCode !== undefined && exitCode !== 0)) {
      return fail(record, `${label}-failed`, `${label} ended ${status} exit ${exitCode}: ${record.logs?.[label]?.slice(-2000) ?? ""}`);
    }
    return onComplete(record);
  } catch (err) {
    return fail(record, `${label}-failed`, err instanceof Error ? err.message : String(err));
  }
}

async function observe(record: ValidationRecord, deps: ValidationStepDeps): Promise<ValidationStepResult> {
  const t0 = record.processStartedAt ?? deps.now();
  return runHarnessPass(record, deps, observeArgv(), "observe", (r) => {
    r.timings.observeMs = deps.now() - t0;
    r.step = "locating";
    return { record: r, nextAlarmDelayMs: 0 };
  });
}

/**
 * Find the scratch directory and clone the observation pass created.
 *
 * Discovered rather than computed. The harness derives the clone's directory name from its source path
 * with its own transformation; duplicating that rule here would silently break the day it changes, and
 * the failure would look like "no candidates" rather than "wrong path".
 */
async function locate(record: ValidationRecord, deps: ValidationStepDeps): Promise<ValidationStepResult> {
  const { sandbox } = deps;
  try {
    const scratchList = await sandbox.exec(`ls -1d ${SCRATCH_ROOT}/diffci-dogfood-* 2>/dev/null || true`, { timeout: 30_000 });
    const scratches = scratchList.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    if (scratches.length !== 1) {
      return fail(record, "scratch-ambiguous", `expected exactly one harness scratch directory, found ${scratches.length}: ${scratches.join(", ")}`);
    }
    const scratch = scratches[0]!;

    const entries = await sandbox.exec(`ls -1 ${shq(scratch)}`, { timeout: 30_000 });
    const clones = entries.stdout.split("\n").map((s) => s.trim()).filter((s) => s && s !== "reports");
    if (clones.length !== 1) {
      return fail(record, "clone-ambiguous", `expected exactly one clone in ${scratch}, found ${clones.length}: ${clones.join(", ")}`);
    }

    const rows = await sandbox.exec(`wc -l < ${OBSERVED_CORPUS_PATH}`, { timeout: 30_000 });
    record.observedRows = Number(rows.stdout.trim()) || 0;
    if (record.observedRows === 0) return fail(record, "no-observations", "the observation pass wrote an empty corpus");

    record.scratchDir = scratch;
    record.clonePath = `${scratch}/${clones[0]!}`;
    record.step = "mutating";
    return { record, nextAlarmDelayMs: 0 };
  } catch (err) {
    return fail(record, "locate-failed", err instanceof Error ? err.message : String(err));
  }
}

async function mutate(record: ValidationRecord, deps: ValidationStepDeps): Promise<ValidationStepResult> {
  if (!record.scratchDir || !record.clonePath) return fail(record, "locate-missing", "mutation reached without a located scratch directory");
  const t0 = record.processStartedAt ?? deps.now();
  return runHarnessPass(record, deps, mutateArgv(deps.job, record.scratchDir, record.clonePath), "mutate", (r) => {
    r.timings.mutateMs = deps.now() - t0;
    r.step = "collecting";
    return { record: r, nextAlarmDelayMs: 0 };
  });
}

/**
 * Copy the run out of the container as text.
 *
 * Individual files rather than a tarball: everything the freeze step needs (`manifest.json`,
 * `results.jsonl`, `COMPLETE`, and the observed corpus) is text, and `sandbox.readFile` returns text.
 * Streaming a binary archive back through the same interface would mean base64 round-tripping for no
 * benefit.
 */
async function collect(record: ValidationRecord, deps: ValidationStepDeps): Promise<ValidationStepResult> {
  const { sandbox, bucket } = deps;
  const t0 = deps.now();
  try {
    const runs = await sandbox.exec(`ls -1 ${RUNS_DIR} 2>/dev/null || true`, { timeout: 30_000 });
    const dirs = runs.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    if (dirs.length !== 1) return fail(record, "run-dir-ambiguous", `expected exactly one run directory, found ${dirs.length}: ${dirs.join(", ")}`);
    const runDirName = dirs[0]!;
    const runDir = `${RUNS_DIR}/${runDirName}`;

    const keys: string[] = [];
    const put = async (name: string, path: string, required: boolean): Promise<boolean> => {
      let content: string;
      try {
        content = (await sandbox.readFile(path)).content;
      } catch (err) {
        if (required) throw new Error(`could not read ${path}: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
      const key = `validation/${record.runId}/${name}`;
      await bucket.put(key, content);
      keys.push(key);
      return true;
    };

    // COMPLETE is deliberately required. A run without it is a partial run, and the freeze step refuses
    // to turn one into evidence - better to fail here than to ship half an experiment to R2.
    await put("manifest.json", `${runDir}/manifest.json`, true);
    await put("results.jsonl", `${runDir}/results.jsonl`, true);
    await put("COMPLETE", `${runDir}/COMPLETE`, true);
    await put("corpus.jsonl", OBSERVED_CORPUS_PATH, true);

    const environment = {
      runId: record.runId,
      jobId: record.jobId,
      reproduces: deps.job.reproduces ?? null,
      runDirName,
      observedRows: record.observedRows ?? null,
      environment: record.environment ?? null,
      timings: record.timings,
      sourceTarballKey: record.sourceTarballKey,
      sourceTarballSha256: record.sourceTarballSha256,
      agentTarballKey: record.agentTarballKey,
    };
    const envKey = `validation/${record.runId}/environment.json`;
    await bucket.put(envKey, `${JSON.stringify(environment, null, 2)}\n`);
    keys.push(envKey);

    if (record.logs?.observe) {
      const k = `validation/${record.runId}/observe.log`;
      await bucket.put(k, record.logs.observe);
      keys.push(k);
    }
    if (record.logs?.mutate) {
      const k = `validation/${record.runId}/mutate.log`;
      await bucket.put(k, record.logs.mutate);
      keys.push(k);
    }

    record.runDirName = runDirName;
    record.resultKeys = keys;
    record.timings.collectMs = deps.now() - t0;
    record.step = "done";
    return { record, nextAlarmDelayMs: null };
  } catch (err) {
    return fail(record, "collect-failed", err instanceof Error ? err.message : String(err));
  }
}

/** The pure state machine, injectable for tests exactly like the analysis shards. */
export async function stepValidation(record: ValidationRecord, deps: ValidationStepDeps): Promise<ValidationStepResult> {
  switch (record.step) {
    case "bootstrapping":
      return bootstrap(record, deps);
    case "preparing":
      return prepare(record, deps);
    case "observing":
      return observe(record, deps);
    case "locating":
      return locate(record, deps);
    case "mutating":
      return mutate(record, deps);
    case "collecting":
      return collect(record, deps);
    default:
      return { record, nextAlarmDelayMs: null };
  }
}

interface ValidationEnv {
  VALIDATION_CONTAINER: unknown;
  VALIDATION_BUCKET: R2BucketLike;
}

interface DurableObjectStateLike {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    setAlarm(time: number): Promise<void>;
    deleteAlarm(): Promise<void>;
  };
}

export class ValidationShard {
  private readonly state: DurableObjectStateLike;
  private readonly env: ValidationEnv;

  constructor(state: DurableObjectStateLike, env: ValidationEnv) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/start") {
        const body = (await request.json()) as {
          runId: string;
          jobId: string;
          sourceTarballKey: string;
          sourceTarballSha256: string;
          agentTarballKey: string;
        };
        const job = getValidationJob(body.jobId);
        if (!job) return Response.json({ ok: false, error: `unknown-job: ${body.jobId}` }, { status: 400 });

        const existing = await this.state.storage.get<ValidationRecord>(STATE_KEY);
        if (existing && !TERMINAL_STEPS.has(existing.step)) {
          // Idempotent: re-seeding a live shard would re-clone and re-install underneath a running pass.
          return Response.json({ ok: true, alreadyRunning: true, record: existing });
        }

        const record = seedValidationRecord(body.runId, job, body, Date.now());
        await this.state.storage.put(STATE_KEY, record);
        await this.state.storage.setAlarm(Date.now() + 1000);
        return Response.json({ ok: true, record });
      }

      if (request.method === "GET" && url.pathname === "/state") {
        const record = await this.state.storage.get<ValidationRecord>(STATE_KEY);
        if (!record) return Response.json({ ok: false, error: "not-found" }, { status: 404 });
        return Response.json(record);
      }

      if (request.method === "POST" && url.pathname === "/cancel") {
        await this.state.storage.deleteAlarm();
        const record = await this.state.storage.get<ValidationRecord>(STATE_KEY);
        if (record && !TERMINAL_STEPS.has(record.step)) {
          record.step = "cancelled";
          await this.state.storage.put(STATE_KEY, record);
        }
        return Response.json({ ok: true });
      }

      return Response.json({ ok: false, error: "not-found" }, { status: 404 });
    } catch (err) {
      return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
    }
  }

  async alarm(): Promise<void> {
    const record = await this.state.storage.get<ValidationRecord>(STATE_KEY);
    if (!record || TERMINAL_STEPS.has(record.step)) return;

    const job = getValidationJob(record.jobId);
    if (!job) {
      record.step = "failed";
      record.errorClass = "unknown-job";
      await this.state.storage.put(STATE_KEY, record);
      await this.state.storage.deleteAlarm();
      return;
    }

    // Imported lazily so the pure state machine above stays loadable under Node/tsx for tests.
    const { getSandbox } = await import("@cloudflare/sandbox");
    const sandbox: SandboxLike = getSandbox(this.env.VALIDATION_CONTAINER as never, `validation-${record.runId}`, SANDBOX_OPTS);

    record.heartbeatAt = Date.now();
    const { record: updated, nextAlarmDelayMs } = await stepValidation(record, {
      sandbox,
      bucket: this.env.VALIDATION_BUCKET,
      job,
      now: () => Date.now(),
    });
    await this.state.storage.put(STATE_KEY, updated);
    if (nextAlarmDelayMs !== null) await this.state.storage.setAlarm(Date.now() + nextAlarmDelayMs);
    else await this.state.storage.deleteAlarm();
  }
}
