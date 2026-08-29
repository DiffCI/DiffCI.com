/**
 * The validation-job allowlist - everything the Linux validation environment is permitted to run
 * (2026-08-28).
 *
 * WHY AN ALLOWLIST AND NOT A COMMAND PARAMETER. The obvious shape for "run the dogfood harness on
 * Linux" is an endpoint that accepts a command string and executes it in a container. That endpoint is
 * a remote code execution service with a bearer token in front of it, and the only thing standing
 * between it and someone else's compute bill is that token never leaking. This module takes the same
 * position `repo-execution-profiles.ts` already takes for execution validation: a caller names a job,
 * and a job absent from this file cannot be run at all. Requests carry an identifier, never a command.
 *
 * Every argv below is a fixed literal defined here. The only request-derived value that reaches the
 * container is the job id, and it is looked up rather than interpolated.
 *
 * WHY THE HEAD SHA IS PINNED. `dogfood-observe` derives its candidate commits from `git log` at the
 * clone's HEAD. Cloning a live repository therefore observes whatever happens to be on `main` that day,
 * so two runs a week apart examine different commits and their funnels are not comparable. A
 * reproduction that silently changes its own inputs is worse than no reproduction, because it still
 * produces a confident-looking number. Pinning is what makes "same corpus" true rather than intended.
 */

/** Where the container does its work. Fixed so the harness flags below can be literals. */
export const WORKSPACE = "/workspace";
/** The pinned clone the corpus points at. Never the tree the harness checks commits out in. */
export const PINNED_CLONE = `${WORKSPACE}/target-src`;
/** TMPDIR for the harness, so `mkdtemp`'s scratch directory lands somewhere discoverable. */
export const SCRATCH_ROOT = `${WORKSPACE}/tmp`;
/** The corpus definition the DO writes, pointing `source` at PINNED_CLONE. */
export const JOB_CORPUS_PATH = `${WORKSPACE}/job-corpus.json`;
/** The observation output, and the mutation pass's input. */
export const OBSERVED_CORPUS_PATH = `${WORKSPACE}/corpus.jsonl`;
/** A shard's own slice of the observed corpus. Only written when a run is sharded. */
export const SHARD_CORPUS_PATH = `${WORKSPACE}/shard-corpus.jsonl`;

/**
 * The most shards one run may be split into.
 *
 * Bounded because each shard is a whole container that clones and installs the target independently -
 * past a point the fixed setup cost per shard exceeds the per-candidate work it saves, and the run gets
 * slower AND more expensive. It also bounds the blast radius of a mistake in a request.
 */
export const MAX_SHARDS = 12;

/**
 * Which shard owns a candidate, by its position in the observed corpus.
 *
 * Round-robin rather than contiguous blocks: candidate cost varies by several multiples (a commit whose
 * mutation is found on the first attempted file costs a fraction of one that walks several), and
 * contiguous blocks would let one shard draw all the expensive ones and set the wall clock alone.
 *
 * Deterministic and position-based, so re-running the same job with the same shard count reproduces the
 * same assignment - a sharded run stays as re-runnable as an unsharded one.
 */
export function assignShard(candidateIndex: number, shardCount: number): number {
  return candidateIndex % shardCount;
}
/** Immutable run directories, collected into R2 at the end. */
export const RUNS_DIR = `${WORKSPACE}/runs`;

export interface ValidationJob {
  id: string;
  description: string;
  /**
   * What this job does in the container.
   *
   * `reproduce` runs observe -> mutate and produces a mutation funnel.
   * `qualify` runs the qualification pass alone - clone, install, documented build, two green baselines
   * - and answers only whether the repository can contribute safety evidence at all. A repository must
   * qualify before mutating it means anything, because a mutation pass against a suite that was never
   * green attributes failures to the mutation that were already there.
   */
  mode: "reproduce" | "qualify";
  /** The frozen bundle this job reproduces, when it is a reproduction rather than new evidence. */
  reproduces?: string;
  /** "owner/name" - cloned from GitHub over https, no credentials. */
  repository: string;
  /** The exact commit the corpus was derived from. 40 lowercase hex. */
  pinnedHeadSha: string;
  /** How many head/base pairs to observe. Required for `reproduce`; unused by `qualify`. */
  commits?: number;
  /** The packaged agent that produced the original evidence. Asserted before anything is measured. */
  expectedAgentIntegrity: string;
  /** Mutation-pass commands, verbatim from the run being reproduced. Required for `reproduce`. */
  mutate?: {
    install: string[];
    testModule: string;
    testArgs: string[];
    maxAttempts: number;
    timeoutMs: number;
  };
  /** Ceiling for the whole harness process. Exceeding it kills the run rather than polling forever. */
  maxRunMs: number;
}

const JOBS: Record<string, ValidationJob> = {
  /**
   * The reproduction experiment (2026-08-28). Same corpus, same agent bytes, same commands, canonical
   * environment - the only deliberate change is the environment itself.
   *
   * The comparison this feeds is CLASSIFICATION STABILITY, not timing: whether the 25 observations
   * still yield 22 candidates, and whether those candidates still classify 13 measurable / 13 confirmed
   * / 0 false green. Wall-clock numbers from a Cloudflare container and a Windows laptop are not
   * comparable and no conclusion here should rest on them.
   *
   * `commits: 25` comes from the frozen corpus.jsonl (25 rows, all honojs/hono), NOT from
   * scripts/dogfood-corpus.json, whose hono entry still says 10 - the registry entry was not updated
   * when the larger observation was run. Reproducing from the registry would have observed 10 commits
   * and produced a funnel that looked like a real disagreement with the frozen result.
   *
   * The install command carries `--silent`, matching the frozen run manifest's `commands` block rather
   * than the registry entry, which omits it. Same reason: the manifest records what actually ran.
   */
  "hono-reproduction": {
    id: "hono-reproduction",
    description: "Reproduce the frozen honojs/hono mutation funnel in the canonical Linux environment.",
    mode: "reproduce",
    reproduces: "2026-08-28T15-17-45-366Z-honojs-hono-cc009a",
    repository: "honojs/hono",
    pinnedHeadSha: "e2740d5a1bd0b4254e517e3af8b60789284bc7bd",
    commits: 25,
    expectedAgentIntegrity: "sha512-mj4GQJLruQTexqkKybpP4KXGSZsqfs5vD7UbeMPQzV5LfqaR7HwKjuT2l7AP6o8yzyk3fC9aeGSWuyk3+CH7Kw==",
    mutate: {
      install: ["npm", "install", "--no-audit", "--no-fund", "--silent"],
      testModule: "node_modules/vitest/vitest.mjs",
      testArgs: ["run"],
      maxAttempts: 2,
      timeoutMs: 900_000,
    },
    // 22 candidates, each up to 2 mutation attempts, each attempt running a suite twice. The Windows
    // run took hours; a ceiling well above it bounds a genuinely hung run without truncating a healthy
    // slow one.
    maxRunMs: 8 * 60 * 60_000,
  },

  /**
   * zod qualification (2026-08-29).
   *
   * THE QUESTION THIS ANSWERS. zod was recorded as mutation-unqualified on the Windows host for a
   * reason that was never a property of zod: its build shells out to a bare `pnpm` that the host did
   * not put on PATH. Both monorepos attempted on that host failed, and both single-package libraries
   * passed, so the corpus was accumulating safety evidence only from the class of repository where the
   * graph-explosion question matters least. This asks whether the canonical environment removes that
   * bias.
   *
   * It runs the qualification pass ALONE - clone, install, documented build, two green baselines - and
   * nothing is mutated here. The commands come from `scripts/dogfood-corpus.json`, which the harness
   * reads for itself; they are not restated here, so there is exactly one place they can drift from.
   *
   * NOT AN ACCOMMODATION: the environment enables corepack generally, which the validation contract
   * explicitly permits ("the repository's own declared package manager, through corepack"). If zod
   * still fails, the reason is recorded and zod stays unqualified. The image must not grow a branch
   * for one project's quirk.
   */
  "zod-qualification": {
    id: "zod-qualification",
    description: "Qualify colinhacks/zod in the canonical Linux environment: install, build, two green baselines.",
    mode: "qualify",
    repository: "colinhacks/zod",
    // main as of 2026-08-29. Pinned for the same reason every job here is: an unpinned qualification
    // verdict describes whatever was on main that morning and cannot be compared to anything later.
    pinnedHeadSha: "e6b6ab347675cd2bd54b1bdbed16f98c59be82a9",
    expectedAgentIntegrity: "sha512-mj4GQJLruQTexqkKybpP4KXGSZsqfs5vD7UbeMPQzV5LfqaR7HwKjuT2l7AP6o8yzyk3fC9aeGSWuyk3+CH7Kw==",
    // A monorepo install plus a workspace build plus two full baselines. Generous, because the failure
    // this bounds is a hung command, not a slow one - and calling a slow honest run a timeout would
    // manufacture exactly the environmental verdict this job exists to test for.
    maxRunMs: 3 * 60 * 60_000,
  },
};

export function getValidationJob(id: string): ValidationJob | undefined {
  return Object.prototype.hasOwnProperty.call(JOBS, id) ? JOBS[id] : undefined;
}

export function listValidationJobs(): string[] {
  return Object.keys(JOBS);
}

/** 40 lowercase hex. Anything else never reaches a command string. */
export function isPinnedSha(sha: string): boolean {
  return /^[0-9a-f]{40}$/.test(sha);
}

/** "owner/name", the character set GitHub actually permits. */
export function isRepositorySlug(repository: string): boolean {
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repository);
}

/**
 * The corpus definition handed to `dogfood-observe`.
 *
 * `source` MUST be the "owner/name" slug, never the pinned clone's path, because `dogfood-observe`
 * records `identity.repository` as `entry.source` verbatim (scripts/dogfood-observe.ts). Pointing it at
 * a local path was tried on 2026-08-29 and produced 25 observations all labelled
 * `/workspace/target-src`; the mutation pass then filtered on `--repository honojs/hono`, matched
 * nothing, and wrote a COMPLETE run with ZERO rows in 30 seconds. It reported success.
 *
 * Pinning is achieved instead by a git `insteadOf` rewrite in the container (see the shard's `prepare`
 * step), so the harness clones this exact slug while git silently serves it from a local mirror parked
 * at `pinnedHeadSha`. Identity stays honest and history stays fixed, without the harness changing.
 */
export function buildJobCorpus(job: ValidationJob): unknown[] {
  return [
    {
      source: job.repository,
      stresses: `${job.description} (pinned at ${job.pinnedHeadSha})`,
      commits: job.commits,
    },
  ];
}

/** Observation pass argv, run from /opt/diffci. Fixed literals only. */
export function observeArgv(): string[] {
  return ["run", "dogfood", "--", "--corpus", JOB_CORPUS_PATH, "--out", OBSERVED_CORPUS_PATH];
}

/**
 * Qualification-pass argv.
 *
 * `--write` so the verdict lands in the container's own copy of `scripts/dogfood-corpus.json`, which is
 * then collected. The harness has no other structured output - without this the verdict would exist
 * only as console text, and a qualification result that can only be read by a human is not evidence.
 *
 * `--clone-depth 0` is a full clone. Builds that ask git what changed cannot answer from a shallow one,
 * which is precisely how TanStack/query was disqualified on the developer host.
 */
export function qualifyArgv(job: ValidationJob): string[] {
  return ["run", "dogfood:qualify", "--", "--only", job.repository, "--clone-depth", "0", "--write"];
}

/** Where the qualification verdict is written inside the container. */
export const CORPUS_DEFINITION_PATH = "scripts/dogfood-corpus.json";

/**
 * Mutation pass argv. `scratch` and `clonePath` are discovered at runtime (the harness names its own
 * mkdtemp directory) and are validated by the caller before they get here - they are the only
 * non-literals, and they are paths this DO created the parent of, never anything a request supplied.
 */
/**
 * A reproduce job's mutation commands, or a loud failure.
 *
 *  is optional on the shared job type because a qualification job has no mutation pass. Reading
 * it without checking would silently produce argv containing "undefined", and the harness would then
 * run with a wrong install command rather than refusing - the class of failure where a run completes and
 * means nothing.
 */
/**
 * A reproduce job's mutation commands, or a loud failure.
 *
 * `mutate` is optional on the shared job type because a qualification job has no mutation pass. Reading
 * it unchecked would put the string "undefined" into argv, and the harness would then run with a wrong
 * install command rather than refusing - the class of failure where a run completes and means nothing,
 * which this corpus has already produced twice.
 */
export function requireMutationCommands(job: ValidationJob): NonNullable<ValidationJob["mutate"]> {
  if (!job.mutate) throw new Error(`job "${job.id}" has mode "${job.mode}" and defines no mutation commands`);
  return job.mutate;
}

export function mutateArgv(job: ValidationJob, scratch: string, clonePath: string, corpusPath: string = OBSERVED_CORPUS_PATH): string[] {
  const mutate = requireMutationCommands(job);
  return [
    "run",
    "dogfood:mutate",
    "--",
    "--repository", job.repository,
    "--repo", clonePath,
    "--corpus", corpusPath,
    "--reports", `${scratch}/reports`,
    "--runs-dir", RUNS_DIR,
    "--max-attempts", String(mutate.maxAttempts),
    "--timeout", String(mutate.timeoutMs),
    "--install", mutate.install.join("|"),
    "--test-module", mutate.testModule,
    "--test-args", mutate.testArgs.join("|"),
  ];
}
