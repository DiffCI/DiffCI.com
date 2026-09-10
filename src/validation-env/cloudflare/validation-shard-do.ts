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
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { apparatusMismatches } from "../apparatus-identity.js";
import { buildExecutionReceipt, type GuardRecord } from "../execution-receipt.js";
import {
  JOB_CORPUS_PATH,
  OBSERVED_CORPUS_PATH,
  PINNED_CLONE,
  SHARD_CORPUS_PATH,
  RUNS_DIR,
  SCRATCH_ROOT,
  WORKSPACE,
  assignShard,
  CORPUS_DEFINITION_PATH,
  buildJobCorpus,
  getValidationJob,
  isPinnedSha,
  isRepositorySlug,
  mutateArgv,
  calibrateArgv,
  observeArgv,
  qualifyArgv,
  surveyArgv,
  densityArgv,
  observePairsArgv,
  registerArgv,
  ciReproduceArgv,
  CI_REPRODUCTION_OUT,
  REGISTRATION_DERIVATION_OUT,
  universeArgv,
  UNIVERSE_OUT,
  DENSITY_OUT,
  SURVEY_OUT,
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
  | "qualifying"
  | "calibrating"
  | "surveying"
  | "measuringDensity"
  | "observingPairs"
  | "verifyingUniverse"
  | "registering"
  | "ciReproducing"
  | "languageQualifying"
  | "locating"
  | "mutating"
  | "collecting"
  | "preserving"
  | "done"
  | "failed"
  | "cancelled";

export interface ValidationRecord {
  runId: string;
  jobId: string;
  /** 0-based position of this shard. 0 with shardCount 1 means an unsharded run. */
  shardIndex: number;
  /** How many shards this run was split into. 1 means unsharded. */
  shardCount: number;
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
    /** Build tools present, or an explicit statement that they are not. Member 4 died on a missing make. */
    buildToolchain?: string;
    /** The agent's own sha512, measured in-container and matched against the job's expectation. */
    agentIntegrity?: string;
  };
  processId?: string;
  processStartedAt?: number;
  scratchDir?: string;
  /** Controls that actually ran, with their verdicts. See execution-receipt.ts. */
  guards?: GuardRecord[];
  /** Allowlisted harness passes executed, in order. */
  commands?: Array<{ label: string; argv: string[]; exitStatus: number | null }>;
  clonePath?: string;
  runDirName?: string;
  resultKeys?: string[];
  observedRows?: number;
  /** Observations the mutation pass will accept in THIS shard, computed before it runs. */
  selectableCandidates?: number;
  /** Selectable candidates across the whole run, identical in every shard. The merge checks it. */
  totalSelectableCandidates?: number;
  /** Rows the mutation pass classified. Zero is a failure, not a result. */
  resultRows?: number;
  errorClass?: string;
  error?: string;
  /** Live progress of the running harness pass, refreshed on every poll. Diagnostic, never load-bearing. */
  progress?: { label: string; elapsedMs: number; at: number; tail: string };
  logs?: { observe?: string; mutate?: string; qualify?: string; calibrate?: string; survey?: string; density?: string; pairs?: string; universe?: string; register?: string; "ci-reproduce"?: string; "language-qualification"?: string };
  /** Set once evidence preservation has run, so a failure inside it cannot loop. */
  evidencePreserved?: boolean;
  /** The step that actually failed, kept because `step` becomes "preserving" then "failed". */
  stepBeforeFailure?: ValidationStep;
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

/**
 * Where a run's artefacts live in R2.
 *
 * An unsharded run keeps the flat layout it has always had, so runs already collected stay readable.
 * A sharded run nests under `shards/<i>/`, because the merge has to distinguish a MISSING shard from
 * one that legitimately wrote nothing - and a flat layout would let shards silently overwrite each
 * other's results.jsonl, the same contamination the immutable run directories were introduced to stop.
 */
function resultPrefix(record: ValidationRecord): string {
  return record.shardCount > 1 ? `validation/${record.runId}/shards/${record.shardIndex}` : `validation/${record.runId}`;
}

/**
 * Record a failure - and preserve the evidence that explains it before terminating.
 *
 * DEFECT #16. A failed run used to end here, which meant `collect` never ran and everything the
 * container had produced was discarded with it. On 2026-08-30 that destroyed the single measurement
 * the Prettier experiment existed to make: 25 observations completed over four hours, `locate` refused
 * because none was selective, and the corpus carrying the REFUSED/FULL/SELECTIVE distribution went
 * with the container. The worst case for the product was also the case where the harness threw away
 * the evidence.
 *
 * So a failure now routes through `preserving`, which makes a best-effort copy of whatever exists into
 * R2 and only then terminates. Preservation is strictly additive: it cannot change a verdict, cannot
 * rescue a run, and cannot fail it a second time - `evidencePreserved` makes a failure inside
 * preservation terminate immediately rather than loop.
 */
function fail(record: ValidationRecord, errorClass: string, error: string): ValidationStepResult {
  record.errorClass = errorClass;
  record.error = error.slice(0, 4000);
  if (record.step !== "preserving") record.stepBeforeFailure = record.step;
  if (record.step === "preserving" || record.evidencePreserved === true) {
    record.step = "failed";
    return { record, nextAlarmDelayMs: null };
  }
  record.step = "preserving";
  return { record, nextAlarmDelayMs: 0 };
}

function tail(result: { stdout?: string; stderr?: string }, n = 1500): string {
  return `${result.stdout ?? ""} ${result.stderr ?? ""}`.trim().slice(-n);
}

export function seedValidationRecord(
  runId: string,
  job: ValidationJob,
  keys: { sourceTarballKey: string; sourceTarballSha256: string; agentTarballKey: string; shardIndex?: number; shardCount?: number },
  now: number,
): ValidationRecord {
  return {
    runId,
    jobId: job.id,
    shardIndex: keys.shardIndex ?? 0,
    shardCount: keys.shardCount ?? 1,
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

    // BUILD TOOLCHAIN — environment equivalence with the runner being reproduced.
    //
    // CI_REPRODUCTION_SAMPLE_01 member 4 died at `make: not found` on step 3 of 9. babel's build is
    // Makefile-driven, GitHub's `ubuntu-latest` ships `make`, and this container did not — so the run
    // never reached the question the sample existed to ask, and was correctly recorded
    // ENVIRONMENT_INADEQUATE rather than as anything about babel or about DiffCI.
    //
    // The container is not a substitute for a GitHub runner unless it carries the toolchain a large
    // fraction of real repositories assume. Provisioned here, ONCE, and verified — so a missing tool is
    // a bootstrap failure with an obvious cause rather than a mid-harness surprise attributed to a
    // repository. Recorded in the environment so evidence says which toolchain produced it.
    let build = await sandbox.exec("make --version && python3 --version && cc --version", { timeout: 20_000 });
    if (!build.success) {
      await sandbox.exec(
        "(command -v apt-get >/dev/null && apt-get update && apt-get install -y --no-install-recommends make python3 build-essential) || " +
          "(command -v apk >/dev/null && apk add --no-cache make python3 build-base) || true",
        { timeout: 600_000 },
      );
      build = await sandbox.exec("make --version && python3 --version && cc --version", { timeout: 20_000 });
    }
    record.environment = {
      ...(record.environment ?? {}),
      buildToolchain: build.success
        ? tail(build, 300)
            .split(/\r?\n/)
            .filter(Boolean)
            .slice(0, 3)
            .join(" | ")
        : "UNAVAILABLE - repositories requiring make/python/cc cannot be reproduced here",
    } as ValidationRecord["environment"];

    // The sandbox image ships Node WITHOUT corepack's shims enabled, so `pnpm` and `yarn` are absent
    // from PATH even though corepack itself is present. That is exactly how colinhacks/zod was
    // disqualified on the developer host - its build shells out to a bare `pnpm`, which was not a
    // property of zod. Enabling corepack is permitted by the validation contract ("the repository's own
    // declared package manager, through corepack"), and it is done for the ENVIRONMENT rather than for
    // any one repository - this image must not grow per-project branches. Best-effort: a repository
    // that needs no package manager beyond npm is unaffected either way.
    await sandbox.exec(
      "(corepack enable >/dev/null 2>&1 || (npm install -g corepack --silent && corepack enable)) >/dev/null 2>&1 || true",
      { timeout: 180_000 },
    );

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

    // A sealed experiment must run on the QUALIFIED apparatus, and is refused otherwise.
    //
    // Checked HERE, in bootstrap, and not at the tail of prepare() where it first lived: calibrate,
    // survey and density all return from prepare() before reaching that point, so the control silently
    // never ran for them. A declared safety check that does not execute is worse than no check, because
    // it is reported as protection. Every mode passes through this line.
    //
    // It is deliberately redundant with the agent-integrity check above, which catches the wrong
    // tarball; this also catches the wrong image or node version, and names every mismatch at once.
    if (job.requiresApparatus === "gen-c") {
      const problems = apparatusMismatches({
        agentIntegrity: record.environment.agentIntegrity,
        image: record.environment.image,
        node: record.environment.node,
      });
      // Recorded BEFORE the early return, so a failing guard is evidence rather than only an error
      // string. A guard that fails still proves it executed.
      record.guards = [
        ...(record.guards ?? []),
        {
          declared: true,
          executed: true,
          name: "requiresApparatus:gen-c",
          result: problems.length === 0 ? "PASS" : "FAIL",
          problems,
        } satisfies GuardRecord,
      ];
      if (problems.length > 0) {
        return fail(record, "apparatus-mismatch", `this job requires the qualified generation-C apparatus: ${problems.join("; ")}`);
      }
    }

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
    if (job.mode === "language-qualification") {
      record.timings.prepareMs = deps.now() - t0;
      record.step = "languageQualifying";
      return { record, nextAlarmDelayMs: 0 };
    }
    // Calibration measures the laboratory, not a repository: nothing is cloned and nothing is pinned.
    if (job.mode === "calibrate") {
      record.timings.prepareMs = deps.now() - t0;
      record.step = "calibrating";
      return { record, nextAlarmDelayMs: 0 };
    }

    // The survey's subject is 40 repositories named by a frozen frame, so there is no single clone to
    // pin. It does its own cloning, one entry at a time, and records the head sha it actually saw.
    // ci-reproduce clones both arms itself, so it needs no pinned clone - like the survey.
    if (job.mode === "ci-reproduce") {
      record.timings.prepareMs = deps.now() - t0;
      record.step = "ciReproducing";
      return { record, nextAlarmDelayMs: 0 };
    }

    if (job.mode === "survey") {
      record.timings.prepareMs = deps.now() - t0;
      record.step = "surveying";
      return { record, nextAlarmDelayMs: 0 };
    }

    // Same shape for the density survey: forty clones, taken by the pass itself.
    if (job.mode === "density") {
      record.timings.prepareMs = deps.now() - t0;
      record.step = "measuringDensity";
      return { record, nextAlarmDelayMs: 0 };
    }

    if (!job.repository || !isRepositorySlug(job.repository)) return fail(record, "invalid-repository", String(job.repository));
    if (!job.pinnedHeadSha || !isPinnedSha(job.pinnedHeadSha)) return fail(record, "invalid-pinned-sha", String(job.pinnedHeadSha));

    const remote = `https://github.com/${job.repository}.git`;

    // Clear any rewrite left by an earlier job before cloning, or this clone would be served from the
    // previous job's mirror.
    await sandbox.exec(`git config --global --unset-all url.${PINNED_CLONE}.insteadOf || true`, { timeout: 30_000 });

    const clone = await sandbox.exec(`rm -rf ${PINNED_CLONE} && git clone --quiet ${remote} ${PINNED_CLONE}`, { timeout: 20 * 60_000 });
    if (!clone.success) return fail(record, "clone-failed", tail(clone));

    // `checkout -B` (a branch, not a detached HEAD) because the harness re-clones this mirror, and a
    // clone of a repository whose HEAD is detached does not reliably reproduce that checkout.
    const pin = await sandbox.exec(`cd ${PINNED_CLONE} && git checkout -B diffci-validation ${job.pinnedHeadSha}`, { timeout: 5 * 60_000 });
    if (!pin.success) return fail(record, "pin-failed", `could not pin ${job.repository} at ${job.pinnedHeadSha}: ${tail(pin)}`);

    // The pin, without lying about identity. `dogfood-observe` records `identity.repository` as the
    // corpus entry's `source` verbatim, so the corpus must name "owner/name" - but that same string is
    // what it hands to `git clone`. This rewrite lets both be true: the harness clones the real slug,
    // git serves it from the mirror above, and the observed history is fixed at `pinnedHeadSha`.
    const rewrite = await sandbox.exec(`git config --global url.${PINNED_CLONE}.insteadOf ${remote}`, { timeout: 30_000 });
    if (!rewrite.success) return fail(record, "pin-rewrite-failed", tail(rewrite));

    // Only the reproduction pass needs a corpus definition; qualification reads the repository's
    // entry from scripts/dogfood-corpus.json inside the source tarball, so the commands live in exactly
    // one place and cannot drift between the job and the registry.
    if (job.mode === "reproduce") {
      await sandbox.writeFile(JOB_CORPUS_PATH, JSON.stringify(buildJobCorpus(job), null, 2));
    }

    record.timings.prepareMs = deps.now() - t0;
    // observe-pairs still needs the pinned clone - its candidates are ancestors of the pinned head -
    // but reads WHICH commits to observe from the sealed list rather than from git log.
    if (job.mode === "observe-pairs") {
      record.timings.prepareMs = deps.now() - t0;
      record.step = "observingPairs";
      return { record, nextAlarmDelayMs: 0 };
    }

    // Universe sanity runs BEFORE the suite qualification: if DiffCI models the wrong set of
    // executable tests there is no point measuring how reliably that suite goes green.
    record.step = job.universe
      ? "verifyingUniverse"
      : job.registerBeforeQualify
        ? "registering"
        : job.mode === "qualify"
          ? "qualifying"
          : "observing";
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
  label: "observe" | "mutate" | "qualify" | "calibrate" | "survey" | "density" | "pairs" | "universe" | "register" | "ci-reproduce" | "language-qualification",
  onComplete: (record: ValidationRecord) => ValidationStepResult,
): Promise<ValidationStepResult> {
  const { sandbox, job } = deps;
  try {
    if (!record.processId) {
      // TMPDIR is what makes the harness's own mkdtemp scratch directory discoverable afterwards; the
      // mutation pass needs the clone and reports the observation pass created inside it.
      //
      // DIFFCI_VALIDATION_IMAGE is what stops the resulting bundle from lying about where it came
      // from. The harness records it into the run manifest, and dogfood-freeze prints "Produced on a
      // developer host, NOT the canonical validation image" when it is absent. Omitting it (2026-08-29)
      // produced a frozen bundle from a Cloudflare container carrying exactly that caveat - the precise
      // opposite of the truth, and a worse failure than having no bundle at all. The node version is
      // included because the image tag alone does not identify the toolchain that produced the evidence.
      const validationImage = `${record.environment?.image ?? "unknown-image"} node=${record.environment?.node ?? "unknown"}`;
      const cmd = `cd ${DIFFCI_DIR} && TMPDIR=${SCRATCH_ROOT} DIFFCI_VALIDATION_IMAGE=${shq(validationImage)} npm ${argv.map(shq).join(" ")}`;
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
      // LIVE PROGRESS, captured on every poll rather than only at the end.
      //
      // ci-repro-03-linux ran 41 minutes with `step: ciReproducing` as the only observable, because logs
      // were fetched exclusively on exit and on the timeout path. getProcessLogs works perfectly well
      // while the process is running - the capability was there, it was just never called on the happy
      // path. A run is most worth observing WHILE it is running, which is exactly when nothing looked.
      try {
        const live = await sandbox.getProcessLogs(record.processId);
        const combined = `${live.stdout ?? ""}
${live.stderr ?? ""}`;
        record.progress = {
          label,
          elapsedMs: deps.now() - (record.processStartedAt ?? deps.now()),
          at: deps.now(),
          // The harness prints one line per operation boundary; the tail names the live operation.
          tail: combined.slice(-4_000),
        };
      } catch {
        /* observability must never take down the run it observes */
      }

      const elapsed = deps.now() - (record.processStartedAt ?? deps.now());
      if (elapsed > job.maxRunMs) {
        // Capture BEFORE killing, and before failing. zod-qualify-01 was killed by this guard after
        // three hours and taught us nothing about where those hours went, because the output was
        // discarded on the way out - the timeout path was the one exit that threw away its evidence.
        // A run that hits its ceiling is exactly the run whose log is most worth having.
        try {
          const logs = await sandbox.getProcessLogs(record.processId);
          record.logs = { ...(record.logs ?? {}), [label]: `${logs.stdout ?? ""}\n${logs.stderr ?? ""}`.slice(-12_000) };
        } catch {
          /* diagnostic only; the run fails below regardless */
        }
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

    // Recorded for BOTH outcomes. A receipt that only lists successful passes cannot be used to ask
    // what actually ran, which is the whole point of keeping one.
    record.commands = [...(record.commands ?? []), { label, argv, exitStatus: exitCode ?? null }];

    if (status !== "completed" || (exitCode !== undefined && exitCode !== 0)) {
      return fail(record, `${label}-failed`, `${label} ended ${status} exit ${exitCode}: ${record.logs?.[label]?.slice(-2000) ?? ""}`);
    }
    return onComplete(record);
  } catch (err) {
    return fail(record, `${label}-failed`, err instanceof Error ? err.message : String(err));
  }
}

/**
 * The qualification pass: clone, install, documented build, two green baselines.
 *
 * Nothing is mutated. This answers only whether the repository can contribute safety evidence at all -
 * mutating a suite that was never green attributes pre-existing failures to the mutation.
 */
/**
 * Register the repository in the corpus registry before qualifying it.
 *
 * The frame-continuation repositories are not in the 20-entry registry, so `dogfood:qualify --only`
 * found nothing and the run failed with "the collected corpus has no entry" - an apparatus gap, not a
 * red suite. Commands come from the repository own manifest under the frozen rule; nothing is chosen
 * per repository. Exit 2 means UNREGISTERABLE, which is an outcome to record, not a crash.
 */
async function ciReproduceStep(record: ValidationRecord, deps: ValidationStepDeps): Promise<ValidationStepResult> {
  const t0 = record.processStartedAt ?? deps.now();
  return runHarnessPass(record, deps, ciReproduceArgv(deps.job), "ci-reproduce", (r) => {
    r.timings.ciReproduceMs = deps.now() - t0;
    r.step = "collecting";
    return { record: r, nextAlarmDelayMs: 0 };
  });
}

async function registerStep(record: ValidationRecord, deps: ValidationStepDeps): Promise<ValidationStepResult> {
  const t0 = record.processStartedAt ?? deps.now();
  return runHarnessPass(record, deps, registerArgv(deps.job), "register", (r) => {
    r.timings.registerMs = deps.now() - t0;
    r.step = "qualifying";
    return { record: r, nextAlarmDelayMs: 0 };
  });
}

async function qualifyStep(record: ValidationRecord, deps: ValidationStepDeps): Promise<ValidationStepResult> {
  const t0 = record.processStartedAt ?? deps.now();
  return runHarnessPass(record, deps, qualifyArgv(deps.job), "qualify", (r) => {
    r.timings.qualifyMs = deps.now() - t0;
    r.step = "collecting";
    return { record: r, nextAlarmDelayMs: 0 };
  });
}

async function calibrateStep(record: ValidationRecord, deps: ValidationStepDeps): Promise<ValidationStepResult> {
  const t0 = record.processStartedAt ?? deps.now();
  return runHarnessPass(record, deps, calibrateArgv(), "calibrate", (r) => {
    r.timings.calibrateMs = deps.now() - t0;
    r.step = "collecting";
    return { record: r, nextAlarmDelayMs: 0 };
  });
}

async function densityStep(record: ValidationRecord, deps: ValidationStepDeps): Promise<ValidationStepResult> {
  const t0 = record.processStartedAt ?? deps.now();
  return runHarnessPass(record, deps, densityArgv(), "density", (r) => {
    r.timings.densityMs = deps.now() - t0;
    r.step = "collecting";
    return { record: r, nextAlarmDelayMs: 0 };
  });
}

async function surveyStep(record: ValidationRecord, deps: ValidationStepDeps): Promise<ValidationStepResult> {
  const t0 = record.processStartedAt ?? deps.now();
  return runHarnessPass(record, deps, surveyArgv(deps.job), "survey", (r) => {
    r.timings.surveyMs = deps.now() - t0;
    r.step = "collecting";
    return { record: r, nextAlarmDelayMs: 0 };
  });
}

async function verifyUniverse(record: ValidationRecord, deps: ValidationStepDeps): Promise<ValidationStepResult> {
  const t0 = record.processStartedAt ?? deps.now();
  return runHarnessPass(record, deps, universeArgv(deps.job), "universe", (r) => {
    r.timings.universeMs = deps.now() - t0;
    r.step = deps.job.mode === "qualify" ? "qualifying" : "observing";
    return { record: r, nextAlarmDelayMs: 0 };
  });
}

async function observePairsStep(record: ValidationRecord, deps: ValidationStepDeps): Promise<ValidationStepResult> {
  const t0 = record.processStartedAt ?? deps.now();
  return runHarnessPass(record, deps, observePairsArgv(deps.job), "pairs", (r) => {
    r.timings.observeMs = deps.now() - t0;

    // `locate` exists to discover the scratch directory and clone that `dogfood` creates for itself.
    // This mode creates neither: it analyses the pinned clone in place, at a path fixed before the run.
    // So the paths are set directly rather than searched for - going through `locate` would look for a
    // `diffci-dogfood-*` directory that does not exist and fail the run for the wrong reason.
    if (deps.job.mutate) {
      r.scratchDir = WORKSPACE;
      r.clonePath = PINNED_CLONE;
      r.step = "mutating";
      return { record: r, nextAlarmDelayMs: 0 };
    }
    r.step = "collecting";
    return { record: r, nextAlarmDelayMs: 0 };
  });
}

async function observe(record: ValidationRecord, deps: ValidationStepDeps): Promise<ValidationStepResult> {
  const t0 = record.processStartedAt ?? deps.now();
  return runHarnessPass(record, deps, observeArgv(), "observe", (r) => {
    r.timings.observeMs = deps.now() - t0;
    // An observation-only job has nothing to locate and nothing to mutate. Routing it through `locate`
    // meant it could only ever reach collection when selectable candidates existed - so the one case an
    // observation run is FOR, explaining why nothing was selected, was the one case it could not report.
    r.step = deps.job.observeOnly === true ? "collecting" : "locating";
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

    // Parsed rather than counted. On 2026-08-29 a run observed 25 rows and still produced zero
    // candidates, because every row was labelled with the pinned clone's PATH instead of "owner/name"
    // and the mutation pass's `--repository` filter then matched none of them. A line count cannot see
    // that; it reported 25 and the run went on to write an empty, COMPLETE, successful-looking result.
    let corpus: string;
    try {
      corpus = (await sandbox.readFile(OBSERVED_CORPUS_PATH)).content;
    } catch (err) {
      return fail(record, "corpus-unreadable", err instanceof Error ? err.message : String(err));
    }
    const lines = corpus.split("\n").filter((line) => line.trim().length > 0);
    const observed = lines.map((line) => ({
      line,
      row: JSON.parse(line) as { identity: { repository: string }; decision: { mode: string; selected: number | string } },
    }));

    record.observedRows = observed.length;
    if (observed.length === 0) return fail(record, "no-observations", "the observation pass wrote an empty corpus");

    const matching = observed.filter((o) => o.row.identity.repository === deps.job.repository);
    if (matching.length === 0) {
      const seen = [...new Set(observed.map((o) => o.row.identity.repository))].join(", ");
      return fail(
        record,
        "corpus-identity-mismatch",
        `the mutation pass filters on repository "${deps.job.repository}", but the ${observed.length} observed row(s) are labelled: ${seen}. Every candidate would be silently discarded.`,
      );
    }

    // The candidates the mutation pass will actually accept: SELECTIVE, having selected something.
    const selectable = matching.filter(
      (o) => o.row.decision.mode === "SELECTIVE" && typeof o.row.decision.selected === "number" && o.row.decision.selected > 0,
    );
    if (selectable.length === 0) {
      return fail(record, "no-candidates", `${matching.length} observation(s) for ${deps.job.repository}, but none were SELECTIVE with a non-empty selection`);
    }
    record.totalSelectableCandidates = selectable.length;

    if (record.shardCount > 1) {
      // Each shard observes the whole corpus (the observation is deterministic once history is pinned)
      // and then mutates only its own slice. Slicing the CORPUS rather than adding a shard flag to the
      // harness keeps the command shape identical to an unsharded run - the only difference is which
      // file `--corpus` points at.
      const mine = selectable.filter((_, index) => assignShard(index, record.shardCount) === record.shardIndex);
      if (mine.length === 0) {
        // Legitimate when shards outnumber candidates. Recorded as done with nothing to do, rather than
        // failed - a shard with no work must not look like a shard that broke.
        record.selectableCandidates = 0;
        record.resultRows = 0;
        record.step = "done";
        return { record, nextAlarmDelayMs: null };
      }
      await sandbox.writeFile(SHARD_CORPUS_PATH, `${mine.map((o) => o.line).join("\n")}\n`);
      record.selectableCandidates = mine.length;
    } else {
      record.selectableCandidates = selectable.length;
    }

    record.scratchDir = scratch;
    record.clonePath = `${scratch}/${clones[0]!}`;
    // An observation-only run stops here by design: the pre-registration requires the predicted sign to
    // be committed before any economics arm executes, and mutating would run them as a side effect.
    record.step = deps.job.observeOnly ? "collecting" : "mutating";
    return { record, nextAlarmDelayMs: 0 };
  } catch (err) {
    return fail(record, "locate-failed", err instanceof Error ? err.message : String(err));
  }
}

async function mutate(record: ValidationRecord, deps: ValidationStepDeps): Promise<ValidationStepResult> {
  if (!record.scratchDir || !record.clonePath) return fail(record, "locate-missing", "mutation reached without a located scratch directory");
  const t0 = record.processStartedAt ?? deps.now();
  const corpusPath = record.shardCount > 1 ? SHARD_CORPUS_PATH : OBSERVED_CORPUS_PATH;
  return runHarnessPass(record, deps, mutateArgv(deps.job, record.scratchDir, record.clonePath, corpusPath), "mutate", (r) => {
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
    if (deps.job.mode === "language-qualification") {
      const content = (await deps.sandbox.readFile("/workspace/language-qualification.json")).content;
      JSON.parse(content);
      const key = `${resultPrefix(record)}/language-qualification.json`;
      const logKey = `${resultPrefix(record)}/language-qualification.log`;
      await deps.bucket.put(key, content);
      await deps.bucket.put(logKey, record.logs?.["language-qualification"] ?? "");
      record.resultKeys = [key, logKey];
      record.timings.collectMs = deps.now() - t0;
      record.step = "done";
      return { record, nextAlarmDelayMs: null };
    }
    // A pair job that mutates produces results.jsonl, a manifest and run directories like any other
    // mutation run, so it takes the FULL collect path. Only the observation-only pair job collects just
    // the corpus.
    if (deps.job.observeOnly || (deps.job.mode === "observe-pairs" && !deps.job.mutate)) return collectObservation(record, deps, t0);
    if (deps.job.mode === "ci-reproduce") return collectCiReproduction(record, deps, t0);
    if (deps.job.mode === "calibrate") return collectCalibration(record, deps, t0);
    if (deps.job.mode === "survey") return collectSurvey(record, deps, t0);
    if (deps.job.mode === "density") return collectDensity(record, deps, t0);
    if (deps.job.mode === "qualify") return collectQualification(record, deps, t0);

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
      const key = `${resultPrefix(record)}/${name}`;
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

    // COMPLETE means the harness finished, NOT that it measured anything. A mutation pass whose
    // candidate list came out empty finishes almost instantly and writes COMPLETE over zero rows - a
    // failure shaped exactly like a success, and the one this whole environment exists to avoid
    // producing. Observed for real on 2026-08-29: 30 seconds, COMPLETE, zero rows, step "done".
    const resultRows = (await sandbox.readFile(`${runDir}/results.jsonl`)).content.split("\n").filter((l) => l.trim().length > 0).length;
    if (resultRows === 0) {
      return fail(
        record,
        "empty-results",
        `the mutation pass completed but classified nothing (0 rows) despite ${record.selectableCandidates ?? "?"} selectable candidate(s) - this is not a result, it is a silent no-op`,
      );
    }
    record.resultRows = resultRows;

    const environment = {
      runId: record.runId,
      jobId: record.jobId,
      reproduces: deps.job.reproduces ?? null,
      runDirName,
      shardIndex: record.shardIndex,
      shardCount: record.shardCount,
      selectableCandidates: record.selectableCandidates ?? null,
      totalSelectableCandidates: record.totalSelectableCandidates ?? null,
      observedRows: record.observedRows ?? null,
      environment: record.environment ?? null,
      timings: record.timings,
      sourceTarballKey: record.sourceTarballKey,
      sourceTarballSha256: record.sourceTarballSha256,
      agentTarballKey: record.agentTarballKey,
    };
    const envKey = `${resultPrefix(record)}/environment.json`;
    await bucket.put(envKey, `${JSON.stringify(environment, null, 2)}\n`);
    keys.push(envKey);

    if (record.logs?.observe) {
      const k = `${resultPrefix(record)}/observe.log`;
      await bucket.put(k, record.logs.observe);
      keys.push(k);
    }
    if (record.logs?.mutate) {
      const k = `${resultPrefix(record)}/mutate.log`;
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

/**
 * Collect a qualification verdict.
 *
 * The qualification harness has no run directory and no results.jsonl - its structured output is the
 * corpus registry it updates in place with `--write`. That file is the verdict: mutationQualified, the
 * reason, and the environment it was qualified in. The console log is collected alongside it because a
 * FAILED qualification's reason is the whole point of running it, and a reason recorded only as console
 * text is not evidence.
 */
async function collectQualification(record: ValidationRecord, deps: ValidationStepDeps, t0: number): Promise<ValidationStepResult> {
  const { sandbox, bucket } = deps;
  const keys: string[] = [];

  let corpus: string;
  try {
    corpus = (await sandbox.readFile(`${DIFFCI_DIR}/${CORPUS_DEFINITION_PATH}`)).content;
  } catch (err) {
    return fail(record, "verdict-unreadable", err instanceof Error ? err.message : String(err));
  }

  // The verdict must actually name the repository this job qualified, or something has gone wrong
  // upstream of the answer and the file describes some other run.
  let verdict: { mutationQualified?: string; mutationQualificationReason?: string } | undefined;
  try {
    const entries = JSON.parse(corpus) as Array<{ source: string; mutationQualified?: string; mutationQualificationReason?: string }>;
    verdict = entries.find((e) => e.source === deps.job.repository);
  } catch (err) {
    return fail(record, "verdict-unparseable", err instanceof Error ? err.message : String(err));
  }
  if (!verdict) {
    return fail(record, "verdict-missing", `the collected corpus has no entry for ${deps.job.repository}`);
  }

  const corpusKey = `${resultPrefix(record)}/corpus-definition.json`;
  await bucket.put(corpusKey, corpus);
  keys.push(corpusKey);

  if (record.logs?.qualify) {
    const logKey = `${resultPrefix(record)}/qualify.log`;
    await bucket.put(logKey, record.logs.qualify);
    keys.push(logKey);
  }

  // Universe sanity. Written here and allowlisted in the worker in the SAME commit - defect #4 and
  // #14 were both this allowlist lagging behind a writer, producing a completed run whose artefacts
  // reached R2 and were then unreadable through the only route that can read them.
  // The derivation behind the commands, not only the commands. Written whenever the registration pass
  // ran, including when it refused - an UNREGISTERABLE verdict is exactly the case where a reader most
  // needs to see what the rule was looking at.
  if (deps.job.registerBeforeQualify) {
    try {
      const derivation = (await sandbox.readFile(REGISTRATION_DERIVATION_OUT)).content;
      const key = `${resultPrefix(record)}/registration-derivation.json`;
      await bucket.put(key, derivation);
      keys.push(key);
    } catch {
      // Absent is itself informative; it does not fail an otherwise complete qualification.
    }
  }

  if (record.logs?.register) {
    const logKey = `${resultPrefix(record)}/register.log`;
    await bucket.put(logKey, record.logs.register);
    keys.push(logKey);
  }

  if (record.logs?.universe) {
    const logKey = `${resultPrefix(record)}/universe.log`;
    await bucket.put(logKey, record.logs.universe);
    keys.push(logKey);
  }
  if (deps.job.universe) {
    try {
      const sanity = (await sandbox.readFile(UNIVERSE_OUT)).content;
      const sanityKey = `${resultPrefix(record)}/universe-sanity.json`;
      await bucket.put(sanityKey, sanity);
      keys.push(sanityKey);
    } catch (err) {
      return fail(record, "universe-sanity-unreadable", err instanceof Error ? err.message : String(err));
    }
  }

  const envKey = `${resultPrefix(record)}/environment.json`;
  await bucket.put(
    envKey,
    `${JSON.stringify(
      {
        runId: record.runId,
        jobId: record.jobId,
        mode: "qualify",
        repository: deps.job.repository,
        pinnedHeadSha: deps.job.pinnedHeadSha,
        mutationQualified: verdict.mutationQualified ?? null,
        reason: verdict.mutationQualificationReason ?? null,
        environment: record.environment ?? null,
        timings: record.timings,
      },
      null,
      2,
    )}\n`,
  );
  keys.push(envKey);

  record.resultKeys = keys;
  record.timings.collectMs = deps.now() - t0;
  record.step = "done";
  return { record, nextAlarmDelayMs: null };
}

/**
 * Collect a calibration run.
 *
 * The suite's own stdout IS the result - it prints measured elapsed times against each bound - and the
 * process exit status says whether every assertion held. Both are recorded, because a calibration that
 * passed and a calibration nobody can inspect are not the same thing, and this apparatus has already
 * produced one verdict whose only artefact was a sentence.
 */
/**
 * Collect the addressability survey.
 *
 * The summary is required and the run fails without it: a survey that produced no funnel produced
 * nothing, and an empty result reported as success is the exact failure this laboratory has already
 * made twice. Per-entry facts are collected too, because a classification that cannot be re-derived
 * from committed evidence cannot be audited.
 */
/**
 * Collect the density survey. The summary is required: a run that produced no summary produced
 * nothing, and an empty result reported as success is the failure this laboratory keeps rediscovering.
 */
async function collectDensity(record: ValidationRecord, deps: ValidationStepDeps, t0: number): Promise<ValidationStepResult> {
  const { sandbox, bucket } = deps;
  const keys: string[] = [];

  const logKey = `${resultPrefix(record)}/density.log`;
  await bucket.put(logKey, record.logs?.density ?? "(no output captured)");
  keys.push(logKey);

  for (const name of ["density-summary.json", "density-rows.json"]) {
    try {
      const content = (await sandbox.readFile(`${DENSITY_OUT}/${name}`)).content;
      const key = `${resultPrefix(record)}/${name}`;
      await bucket.put(key, content);
      keys.push(key);
    } catch (err) {
      if (name === "density-summary.json") {
        return fail(record, "density-summary-missing", `the density survey produced no summary: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  record.resultKeys = keys;
  record.timings.collectMs = deps.now() - t0;
  record.step = "done";
  return { record, nextAlarmDelayMs: null };
}

async function collectSurvey(record: ValidationRecord, deps: ValidationStepDeps, t0: number): Promise<ValidationStepResult> {
  const { sandbox, bucket } = deps;
  const keys: string[] = [];

  const logKey = `${resultPrefix(record)}/survey.log`;
  await bucket.put(logKey, record.logs?.survey ?? "(no output captured)");
  keys.push(logKey);

  let summary: string;
  try {
    summary = (await sandbox.readFile(`${SURVEY_OUT}/survey-summary.json`)).content;
  } catch (err) {
    return fail(record, "survey-summary-missing", `the survey produced no summary: ${err instanceof Error ? err.message : String(err)}`);
  }
  const summaryKey = `${resultPrefix(record)}/survey-summary.json`;
  await bucket.put(summaryKey, summary);
  keys.push(summaryKey);

  // Guard, in the same spirit as the empty-corpus refusal: a summary whose chain is empty is not a
  // result, however well-formed the JSON is, and a short walk is not a completed survey.
  try {
    const parsed = JSON.parse(summary) as { chain?: { frameEntries?: number }; adjudications?: unknown[] };
    if (!parsed.chain?.frameEntries || !Array.isArray(parsed.adjudications) || parsed.adjudications.length === 0) {
      return fail(record, "survey-empty", "the survey summary contains no adjudications");
    }
    if (parsed.adjudications.length !== parsed.chain.frameEntries) {
      return fail(
        record,
        "survey-incomplete",
        `${parsed.adjudications.length} adjudication(s) for ${parsed.chain.frameEntries} frame entries - the walk did not finish`,
      );
    }
  } catch (err) {
    return fail(record, "survey-summary-unreadable", err instanceof Error ? err.message : String(err));
  }

  const listing = await sandbox.exec(`ls -1 ${SURVEY_OUT}/facts 2>/dev/null || true`, { timeout: 60_000 });
  for (const name of listing.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
    try {
      const content = (await sandbox.readFile(`${SURVEY_OUT}/facts/${name}`)).content;
      const key = `${resultPrefix(record)}/facts/${name}`;
      await bucket.put(key, content);
      keys.push(key);
    } catch {
      // One unreadable facts file must not lose the whole survey; the summary already records the entry.
    }
  }

  record.resultKeys = keys;
  record.timings.collectMs = deps.now() - t0;
  record.step = "done";
  return { record, nextAlarmDelayMs: null };
}

/**
 * Collect a CI_REPRODUCTION run.
 *
 * There is no run directory and no results.jsonl: nothing was mutated and no corpus was observed. The
 * two arms' receipts ARE the result, and the reproduction verdict is computed by the harness rather than
 * by this collector — so a missing artefact is a failure, not something to substitute a default for.
 */
async function collectCiReproduction(record: ValidationRecord, deps: ValidationStepDeps, t0: number): Promise<ValidationStepResult> {
  const { sandbox, bucket } = deps;
  const keys: string[] = [];

  let reproduction: string;
  try {
    reproduction = (await sandbox.readFile(`${CI_REPRODUCTION_OUT}/reproduction.json`)).content;
  } catch (err) {
    return fail(record, "reproduction-unreadable", err instanceof Error ? err.message : String(err));
  }
  const key = `${resultPrefix(record)}/reproduction.json`;
  await bucket.put(key, reproduction);
  keys.push(key);

  const log = record.logs?.["ci-reproduce"] ?? "(no output captured)";
  const logKey = `${resultPrefix(record)}/ci-reproduce.log`;
  await bucket.put(logKey, log);
  keys.push(logKey);

  const envKey = `${resultPrefix(record)}/environment.json`;
  await bucket.put(
    envKey,
    `${JSON.stringify(
      {
        runId: record.runId,
        jobId: record.jobId,
        mode: "ci-reproduce",
        repository: deps.job.repository,
        pinnedHeadSha: deps.job.pinnedHeadSha,
        environment: record.environment ?? null,
        timings: record.timings,
        sourceTarballKey: record.sourceTarballKey,
        sourceTarballSha256: record.sourceTarballSha256,
      },
      null,
      2,
    )}\n`,
  );
  keys.push(envKey);

  record.resultKeys = keys;
  record.timings.collectMs = deps.now() - t0;
  record.step = "done";
  return { record, nextAlarmDelayMs: null };
}

async function collectCalibration(record: ValidationRecord, deps: ValidationStepDeps, t0: number): Promise<ValidationStepResult> {
  const { bucket } = deps;
  const keys: string[] = [];

  const log = record.logs?.calibrate ?? "(no output captured)";
  const logKey = `${resultPrefix(record)}/calibration.log`;
  await bucket.put(logKey, log);
  keys.push(logKey);

  const envKey = `${resultPrefix(record)}/environment.json`;
  await bucket.put(
    envKey,
    `${JSON.stringify(
      {
        runId: record.runId,
        jobId: record.jobId,
        mode: "calibrate",
        environment: record.environment ?? null,
        timings: record.timings,
        sourceTarballKey: record.sourceTarballKey,
        sourceTarballSha256: record.sourceTarballSha256,
      },
      null,
      2,
    )}\n`,
  );
  keys.push(envKey);

  record.resultKeys = keys;
  record.timings.collectMs = deps.now() - t0;
  record.step = "done";
  return { record, nextAlarmDelayMs: null };
}

/**
 * Collect an observation-only run.
 *
 * There is no run directory and no results.jsonl, because nothing was mutated. The corpus IS the
 * result: each row carries the comparator's selection count, DiffCI's, and the measured joint analysis
 * CPU - the three inputs the frozen prediction rule consumes.
 */
async function collectObservation(record: ValidationRecord, deps: ValidationStepDeps, t0: number): Promise<ValidationStepResult> {
  const { sandbox, bucket } = deps;
  const keys: string[] = [];

  let corpus: string;
  try {
    corpus = (await sandbox.readFile(OBSERVED_CORPUS_PATH)).content;
  } catch (err) {
    return fail(record, "corpus-unreadable", err instanceof Error ? err.message : String(err));
  }
  const rows = corpus.split("\n").filter((l) => l.trim().length > 0).length;
  if (rows === 0) return fail(record, "no-observations", "the observation pass wrote an empty corpus");

  const corpusKey = `${resultPrefix(record)}/corpus.jsonl`;
  await bucket.put(corpusKey, corpus);
  keys.push(corpusKey);

  if (record.logs?.observe) {
    const logKey = `${resultPrefix(record)}/observe.log`;
    await bucket.put(logKey, record.logs.observe);
    keys.push(logKey);
  }

  const envKey = `${resultPrefix(record)}/environment.json`;
  await bucket.put(
    envKey,
    `${JSON.stringify(
      {
        runId: record.runId,
        jobId: record.jobId,
        mode: "observe-only",
        repository: deps.job.repository ?? null,
        pinnedHeadSha: deps.job.pinnedHeadSha ?? null,
        observedRows: record.observedRows ?? null,
        selectableCandidates: record.selectableCandidates ?? null,
        environment: record.environment ?? null,
        timings: record.timings,
        sourceTarballKey: record.sourceTarballKey,
        sourceTarballSha256: record.sourceTarballSha256,
        agentTarballKey: record.agentTarballKey,
      },
      null,
      2,
    )}\n`,
  );
  keys.push(envKey);

  record.resultKeys = keys;
  record.timings.collectMs = deps.now() - t0;
  record.step = "done";
  return { record, nextAlarmDelayMs: null };
}

/** The pure state machine, injectable for tests exactly like the analysis shards. */
/**
 * Best-effort evidence dump for a failed run. Never throws, never changes the verdict.
 *
 * Everything is attempted independently and every failure is swallowed: one unreadable artefact must
 * not cost the others. The run always ends `failed`, carrying the original errorClass and error.
 */
async function preserveEvidence(record: ValidationRecord, deps: ValidationStepDeps): Promise<ValidationStepResult> {
  const { sandbox, bucket } = deps;
  const keys = record.resultKeys ? [...record.resultKeys] : [];
  const prefix = `${resultPrefix(record)}/failed`;

  const put = async (name: string, read: () => Promise<string | undefined>): Promise<void> => {
    try {
      const content = await read();
      if (content === undefined || content.length === 0) return;
      const key = `${prefix}/${name}`;
      await bucket.put(key, content);
      keys.push(key);
    } catch {
      // Deliberately silent. Preservation is additive; a missing artefact is not a new failure.
    }
  };

  // What the harness printed. Already in memory, so this survives even a dead container.
  for (const [label, text] of Object.entries(record.logs ?? {})) {
    if (typeof text === "string") await put(`${label}.log`, async () => text);
  }

  await put("failure.json", async () =>
    `${JSON.stringify(
      {
        runId: record.runId,
        jobId: record.jobId,
        shardIndex: record.shardIndex,
        failedAtStep: record.stepBeforeFailure ?? null,
        errorClass: record.errorClass ?? null,
        error: record.error ?? null,
        timings: record.timings,
        environment: record.environment ?? null,
        sourceTarballKey: record.sourceTarballKey,
        sourceTarballSha256: record.sourceTarballSha256,
      },
      null,
      2,
    )}\n`,
  );

  // The observed corpus - the artefact a locate-stage refusal used to destroy.
  await put("corpus.jsonl", async () => (await sandbox.readFile(OBSERVED_CORPUS_PATH)).content);
  await put("survey-summary.json", async () => (await sandbox.readFile(`${SURVEY_OUT}/survey-summary.json`)).content);

  // Whatever the mutation pass had written before it stopped.
  try {
    const listing = await sandbox.exec(`ls -1 ${RUNS_DIR} 2>/dev/null || true`, { timeout: 30_000 });
    const dirs = listing.stdout.split("\n").map((d) => d.trim()).filter(Boolean).slice(0, 4);
    for (const dir of dirs) {
      for (const file of ["results.jsonl", "manifest.json", "corpus.jsonl"]) {
        await put(`${dir}-${file}`, async () => (await sandbox.readFile(`${RUNS_DIR}/${dir}/${file}`)).content);
      }
    }
  } catch {
    // As above.
  }

  record.resultKeys = keys;
  record.evidencePreserved = true;
  record.step = "failed";
  return { record, nextAlarmDelayMs: null };
}

/**
 * Writes the execution receipt for a run that has reached a terminal step.
 *
 * ONE place, so every mode emits the same record. Four collectors each writing their own provenance is
 * how survey mode ended up with no `environment.json` at all while calibration, qualification and
 * observation had one - provenance semantics silently differing by mode is exactly what the receipt
 * invariant exists to stop.
 *
 * Best-effort: a receipt that cannot be written must not turn a completed run into a failed one, but
 * its absence is visible rather than papered over.
 */
async function writeExecutionReceipt(record: ValidationRecord, deps: ValidationStepDeps): Promise<void> {
  try {
    const receipt = buildExecutionReceipt(
      {
        runId: record.runId,
        jobId: record.jobId,
        mode: deps.job.mode,
        shardIndex: record.shardIndex,
        environment: record.environment,
        sourceTarballKey: record.sourceTarballKey,
        sourceTarballSha256: record.sourceTarballSha256,
        // A DECLARED guard that never ran must appear as NOT_REACHED, not vanish. An empty guards
        // array is indistinguishable from "this job declared no guard" - which is precisely the
        // defect-19 blind spot the receipt exists to close. e2-12-jest-dom died in bootstrap before
        // the guard, and reported [] until this was fixed.
        guards:
          deps.job.requiresApparatus && !(record.guards ?? []).some((g) => g.name === `requiresApparatus:${deps.job.requiresApparatus}`)
            ? [
                ...(record.guards ?? []),
                {
                  declared: true,
                  executed: false,
                  name: `requiresApparatus:${deps.job.requiresApparatus}`,
                  result: "NOT_REACHED" as const,
                  problems: ["the run failed before this control was reached"],
                },
              ]
            : record.guards,
        commands: record.commands,
        timings: record.timings,
        step: record.step,
        stepBeforeFailure: record.stepBeforeFailure,
        errorClass: record.errorClass,
        error: record.error,
      },
      new Date(deps.now()).toISOString(),
    );
    const key = `${resultPrefix(record)}/execution-receipt.json`;
    await deps.bucket.put(key, `${JSON.stringify(receipt, null, 2)}
`);
    record.resultKeys = [...(record.resultKeys ?? []), key];
  } catch {
    // The run stands or falls on its own result; a missing receipt is visible by its absence.
  }
}

export async function stepValidation(record: ValidationRecord, deps: ValidationStepDeps): Promise<ValidationStepResult> {
  const result = await stepValidationInner(record, deps);
  // Every terminal path, every mode, one record.
  if (result.record.step === "done" || result.record.step === "failed") {
    await writeExecutionReceipt(result.record, deps);
  }
  return result;
}

async function stepValidationInner(record: ValidationRecord, deps: ValidationStepDeps): Promise<ValidationStepResult> {
  switch (record.step) {
    case "bootstrapping":
      return bootstrap(record, deps);
    case "preparing":
      return prepare(record, deps);
    case "observing":
      return observe(record, deps);
    case "qualifying":
      return qualifyStep(record, deps);
    case "calibrating":
      return calibrateStep(record, deps);
    case "surveying":
      return surveyStep(record, deps);
    case "measuringDensity":
      return densityStep(record, deps);
    case "observingPairs":
      return observePairsStep(record, deps);
    case "verifyingUniverse":
      return verifyUniverse(record, deps);
    case "registering":
      return registerStep(record, deps);
    case "ciReproducing":
      return ciReproduceStep(record, deps);
    case "languageQualifying":
      return runHarnessPass(record, deps, deps.job.id.startsWith("language-benchmark-")
        ? ["exec", "--", "tsx", "scripts/benchmark-languages.mjs", deps.job.id.slice("language-benchmark-".length)]
        : ["exec", "--", "tsx", "scripts/qualify-language-adapters.mjs"], "language-qualification", (r) => {
        r.step = "collecting";
        return { record: r, nextAlarmDelayMs: 0 };
      });
    case "locating":
      return locate(record, deps);
    case "mutating":
      return mutate(record, deps);
    case "collecting":
      return collect(record, deps);
    case "preserving":
      return preserveEvidence(record, deps);
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
          shardIndex?: number;
          shardCount?: number;
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

      // Export the already-qualified bytes, not a fresh build or a caller-supplied path.
      if (request.method === "POST" && url.pathname === "/export-observer-012") {
        const record = await this.state.storage.get<ValidationRecord>(STATE_KEY);
        if (record?.step !== "done" || record.runId !== "adapters-012-20260910-v3") return Response.json({ ok: false, error: "qualified-run-required" }, { status: 409 });
        const expected = "sha512-FiVDAHdmzEZKE1Gh0EzfyTv0LNxfzy6JsrcEGR52G41ErixoS7DOha9qr1m+D1fRwVk6o3j+UbXcRk+jupuQUg==";
        const { getSandbox } = await import("@cloudflare/sandbox");
        const sandbox: SandboxLike = getSandbox(this.env.VALIDATION_CONTAINER as never, `validation-${record.runId}`, SANDBOX_OPTS);
        const output = await sandbox.exec("base64 -w0 /opt/diffci/dist-agent/diffci-observer-0.1.2.tgz", { timeout: 30_000 });
        if (output.exitCode !== 0) throw new Error("qualified artifact is no longer present in the container");
        const bytes = Buffer.from(output.stdout.trim(), "base64");
        const integrity = "sha512-" + createHash("sha512").update(bytes).digest("base64");
        if (integrity !== expected) throw new Error("qualified artifact integrity mismatch; export refused");
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const key = `agents/observer-${sha256.slice(0, 16)}.tgz`;
        await this.env.VALIDATION_BUCKET.put(key, bytes);
        const descriptor = { version: "0.1.2", key, sha256, integrity, qualificationRunId: record.runId, sourceTarballSha256: record.sourceTarballSha256, sizeBytes: bytes.length };
        await this.env.VALIDATION_BUCKET.put("releases/observer/0.1.2.json", JSON.stringify(descriptor));
        return Response.json({ ok: true, ...descriptor });
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
