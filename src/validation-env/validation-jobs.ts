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
  mode: "reproduce" | "qualify" | "calibrate" | "survey";
  /** The frozen bundle this job reproduces, when it is a reproduction rather than new evidence. */
  reproduces?: string;
  /** "owner/name" - cloned from GitHub over https, no credentials. Unused by `calibrate`. */
  repository?: string;
  /** The exact commit the corpus was derived from. 40 lowercase hex. Unused by `calibrate`. */
  pinnedHeadSha?: string;
  /** How many head/base pairs to observe. Required for `reproduce`; unused by `qualify`. */
  commits?: number;
  /** The packaged agent that produced the original evidence. Asserted before anything is measured. */
  expectedAgentIntegrity: string;
  /** Mutation-pass commands, verbatim from the run being reproduced. Required for `reproduce`. */
  mutate?: {
    install: string[];
    /**
     * Run after install and before every test run, when the repository needs one.
     *
     * Absent for hono, which needs none. REQUIRED for any repository that qualified with a build:
     * zod's tests import workspace package outputs, so a mutation pass without its build would produce
     * a dirty baseline on every candidate and a funnel that says nothing about DiffCI. An earlier
     * incarnation of this flag existed in the harness but was never passed by its caller, and the two
     * runs it silently made identical were only caught by a run manifest.
     */
    build?: string[];
    testModule: string;
    testArgs: string[];
    maxAttempts: number;
    timeoutMs: number;
  };
  /**
   * Stop after observation and collect the corpus, running NO mutation and NO economics arms.
   *
   * Exists because the comparator-volatility pre-registration (docs/stabiliser-hypothesis-preregistration.md)
   * requires the predicted sign to be committed BEFORE any economics measurement. The reproduce pipeline
   * would otherwise execute the economics arms as a side effect of mutating, which would mean seeing the
   * answer before recording the prediction - and an unfalsifiable experiment.
   */
  observeOnly?: boolean;
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

  /**
   * TanStack/query qualification (2026-08-29).
   *
   * Its recorded disqualification had two causes, and the canonical environment addresses both:
   *
   *   1. 59 tests failed at HEAD because workspace package outputs were missing
   *      ("Failed to resolve entry for package @tanstack/svelte-query"). Deterministic, not flaky - 59
   *      on both baseline runs. The registry entry carried NO build command at all.
   *   2. Its documented build is nx-affected-based, which needs git history the shallow clone did not
   *      have. Qualification here uses a full clone.
   *
   * The registry now carries `corepack pnpm build:all`. That is a choice between two of the
   * repository's OWN documented scripts, recorded with its reason in the corpus entry: `build` is
   * `nx affected`, which computes nothing on an unmodified tree and so leaves exactly the outputs the
   * tests import missing; `build:all` is `nx run-many`, which builds every package. It is not a
   * command invented for this harness.
   *
   * If it still fails, the reason is recorded and TanStack stays unqualified. That would itself be a
   * finding worth having - that a tightly coupled monorepo is not reproducible under a reasonable
   * modern CI environment - and it is worth more than narrowing the corpus to what happens to work.
   */
  "tanstack-qualification": {
    id: "tanstack-qualification",
    description: "Qualify TanStack/query in the canonical Linux environment: install, full workspace build, two green baselines.",
    mode: "qualify",
    repository: "TanStack/query",
    // main as of 2026-08-29.
    pinnedHeadSha: "2969edf32f7e0c48e2a108d84712d6e01edfde21",
    expectedAgentIntegrity: "sha512-mj4GQJLruQTexqkKybpP4KXGSZsqfs5vD7UbeMPQzV5LfqaR7HwKjuT2l7AP6o8yzyk3fC9aeGSWuyk3+CH7Kw==",
    // Larger than zod's: an nx run-many build across every workspace package, then two full baselines.
    maxRunMs: 4 * 60 * 60_000,
  },

  /**
   * The zod mutation pass (2026-08-29). The first mutation evidence from a MONOREPO.
   *
   * hono established that DiffCI's selection preserves mutation-detection recall on a single-package
   * library, reproduced across environments. The open question is whether that survives a large
   * monorepo with a 7,808-test universe - the repository class the earlier evidence could not reach,
   * and the one where graph reasoning should have the most to offer and the most room to go wrong.
   *
   * PRE-REGISTERED, so the result is not chosen after the fact:
   *   - one pass, existing candidate-generation methodology, selector unchanged
   *   - whatever N comes out measurable is what gets analysed - no topping up a flattering denominator
   *   - freeze before interpreting
   *   - a FALSE_GREEN stops everything and is investigated, not averaged
   *
   * The commands are zod's own, exactly as qualification ran them (zod-qualify-02: 573 files, 7808
   * tests, green twice, exit 0 twice). `build` is present and load-bearing: zod's tests import
   * workspace package outputs, so omitting it would make every baseline dirty and the funnel
   * meaningless.
   *
   * `commits: 25` matches the hono run that produced the canonical evidence, not the registry's 10,
   * so the two mutation passes are generated the same way.
   */
  "zod-mutation": {
    id: "zod-mutation",
    description: "First monorepo mutation pass: colinhacks/zod in the canonical Linux environment.",
    mode: "reproduce",
    repository: "colinhacks/zod",
    pinnedHeadSha: "e6b6ab347675cd2bd54b1bdbed16f98c59be82a9",
    commits: 25,
    expectedAgentIntegrity: "sha512-mj4GQJLruQTexqkKybpP4KXGSZsqfs5vD7UbeMPQzV5LfqaR7HwKjuT2l7AP6o8yzyk3fC9aeGSWuyk3+CH7Kw==",
    mutate: {
      install: ["corepack", "pnpm", "install", "--frozen-lockfile"],
      build: ["corepack", "pnpm", "build"],
      testModule: "node_modules/vitest/vitest.mjs",
      testArgs: ["run"],
      maxAttempts: 2,
      timeoutMs: 900_000,
    },
    // Qualification measured baselines at 77s and 56s against hono's ~32s. Each candidate runs a build
    // plus up to three suite executions, so this is a materially heavier pass than hono's 42 minutes.
    maxRunMs: 8 * 60 * 60_000,
  },

  /**
   * REPOSITORY #3 (2026-08-30). Named externally after the hypothesis, prediction rule and eligibility
   * criteria were frozen at e12c207, without access to any DiffCI observation of it.
   *
   * `vitest-dev/vitest` was the primary selection and was REJECTED against the frozen criteria without
   * amending them: it has no root vitest config at all, and its tests are orchestrated by pnpm
   * workspace filters, so the harness cannot invoke them with explicit file paths. `vuejs/core` is the
   * mechanical fallback.
   *
   * Commands come from the corpus registry, where the reasoning is recorded: Vue's documented
   * `test-unit` (`vitest --project unit*`) rather than its default `test`, because the default also
   * runs an e2e-browser project requiring playwright chromium, which the validation contract forbids.
   *
   * QUALIFICATION FIRST, and separately, because the pre-registration forbids running economics before
   * the prediction is frozen. This job also supplies the cost-per-test calibration the prediction rule
   * needs, since qualification already executes the full suite and now records its CPU.
   */
  "vue-qualification": {
    id: "vue-qualification",
    description: "Qualify vuejs/core in the canonical Linux environment, and calibrate cost-per-test.",
    mode: "qualify",
    repository: "vuejs/core",
    pinnedHeadSha: "d63616ca17de965ed32dcb449a4c5cd9982f15d2",
    expectedAgentIntegrity: "sha512-mlNTeKlrkt6TqWBGi9e5O/QM90t7vXpmwyBIly5Mm1glHzRotWmV1s9A1PK3zJIwfntHEgh8S/t3lRJOYucN8g==",
    maxRunMs: 3 * 60 * 60_000,
  },

  /**
   * Vue OBSERVATION ONLY (2026-08-30). No mutation, no economics arms.
   *
   * Produces exactly the three inputs the frozen prediction rule needs: the comparator's selection
   * count, DiffCI's selection count, and the measured joint analysis CPU - all from the canonical
   * environment, so they are comparable with hono's and zod's rather than measured on a laptop.
   *
   * The predicted sign is computed from this output and committed before any economics run.
   */
  "vue-observation": {
    id: "vue-observation",
    description: "Observation only for vuejs/core: selection counts and analysis CPU, no economics.",
    mode: "reproduce",
    observeOnly: true,
    repository: "vuejs/core",
    pinnedHeadSha: "d63616ca17de965ed32dcb449a4c5cd9982f15d2",
    commits: 25,
    expectedAgentIntegrity: "sha512-mlNTeKlrkt6TqWBGi9e5O/QM90t7vXpmwyBIly5Mm1glHzRotWmV1s9A1PK3zJIwfntHEgh8S/t3lRJOYucN8g==",
    mutate: {
      install: ["corepack", "pnpm", "install", "--frozen-lockfile"],
      testModule: "node_modules/vitest/vitest.mjs",
      testArgs: ["run", "--project", "unit*"],
      maxAttempts: 2,
      timeoutMs: 900_000,
    },
    // Observation only - a clone, an install and 25 analyses. Nothing executes a test suite.
    maxRunMs: 2 * 60 * 60_000,
  },

  /**
   * ECONOMICS RUNS (2026-08-29), under agent generation B.
   *
   * Separate jobs rather than a flag on the safety jobs, because the agent generations must not be able
   * to cross. A safety job asserts agent A's integrity and would refuse to run under B; these assert B
   * and would refuse under A. The boundary is enforced by the container's own pre-flight check rather
   * than by remembering which digest belongs to which experiment.
   *
   * B differs from A in exactly one respect - it exposes `pathBaseline.selectedTests`, the comparator's
   * already-computed selection - which is what makes the comparator arm executable rather than merely
   * countable. Verified by scripts/agent-equivalence.ts across 20 observations and 44 pre-existing
   * fields with zero differences.
   *
   * The safety bundles are NOT regenerated under B. Those conclusions were produced by A and keep
   * saying so.
   *
   * hono runs FIRST. Its test-count evidence says DiffCI was overbroad against the comparator on 12 of
   * 20 measurable mutations, so it is the closest thing to a negative control this corpus has: if CPU
   * measurement shows DiffCI winning here too, the meter and the accounting are suspect before the
   * result is interesting.
   */
  "hono-economics": {
    id: "hono-economics",
    description: "Compute measurement for honojs/hono under agent B: full, comparator and DiffCI arms on the unmutated tree.",
    mode: "reproduce",
    repository: "honojs/hono",
    pinnedHeadSha: "e2740d5a1bd0b4254e517e3af8b60789284bc7bd",
    commits: 25,
    expectedAgentIntegrity: "sha512-mlNTeKlrkt6TqWBGi9e5O/QM90t7vXpmwyBIly5Mm1glHzRotWmV1s9A1PK3zJIwfntHEgh8S/t3lRJOYucN8g==",
    mutate: {
      install: ["npm", "install", "--no-audit", "--no-fund", "--silent"],
      testModule: "node_modules/vitest/vitest.mjs",
      testArgs: ["run"],
      maxAttempts: 2,
      timeoutMs: 900_000,
    },
    // Two extra suite executions per candidate on top of the safety pass, so a wider ceiling than the
    // 42 minutes the safety run took.
    maxRunMs: 8 * 60 * 60_000,
  },

  "zod-economics": {
    id: "zod-economics",
    description: "Compute measurement for colinhacks/zod under agent B: full, comparator and DiffCI arms on the unmutated tree.",
    mode: "reproduce",
    repository: "colinhacks/zod",
    pinnedHeadSha: "e6b6ab347675cd2bd54b1bdbed16f98c59be82a9",
    commits: 25,
    expectedAgentIntegrity: "sha512-mlNTeKlrkt6TqWBGi9e5O/QM90t7vXpmwyBIly5Mm1glHzRotWmV1s9A1PK3zJIwfntHEgh8S/t3lRJOYucN8g==",
    mutate: {
      install: ["corepack", "pnpm", "install", "--frozen-lockfile"],
      build: ["corepack", "pnpm", "build"],
      testModule: "node_modules/vitest/vitest.mjs",
      testArgs: ["run"],
      maxAttempts: 2,
      timeoutMs: 900_000,
    },
    maxRunMs: 8 * 60 * 60_000,
  },

  /**
   * Vue ECONOMICS (2026-08-30) - the out-of-sample test of the frozen prediction.
   *
   * `docs/vue-prediction-frozen.md`, committed at 243d110 BEFORE this job existed, predicts a NEGATIVE
   * incremental sign: DiffCI selects 1846 files against the comparator's 591 across 16 candidates, the
   * inverse of zod.
   *
   * Nothing here is tuned for that prediction. Same commands as the observation run, same pin, same
   * agent, same accounting - the comparator still pays zero analysis CPU. The pre-registration's whole
   * point is that this job cannot be adjusted now that the prediction is fixed.
   *
   * The 148.12 / 183 calibration remains a PREDICTION-MODEL INPUT only. Once this run lands, its three
   * measured arms supersede that approximation for evaluating Vue; the approximation is never mixed
   * into the measured result.
   */
  "vue-economics": {
    id: "vue-economics",
    description: "Compute measurement for vuejs/core under agent B - out-of-sample test of a frozen NEGATIVE prediction.",
    mode: "reproduce",
    repository: "vuejs/core",
    pinnedHeadSha: "d63616ca17de965ed32dcb449a4c5cd9982f15d2",
    commits: 25,
    expectedAgentIntegrity: "sha512-mlNTeKlrkt6TqWBGi9e5O/QM90t7vXpmwyBIly5Mm1glHzRotWmV1s9A1PK3zJIwfntHEgh8S/t3lRJOYucN8g==",
    mutate: {
      install: ["corepack", "pnpm", "install", "--frozen-lockfile"],
      // No build: Vue's unit projects resolve packages through source aliases, confirmed by
      // vue-qualify-01 going green with no build stage.
      testModule: "node_modules/vitest/vitest.mjs",
      testArgs: ["run", "--project", "unit*"],
      maxAttempts: 2,
      timeoutMs: 900_000,
    },
    // 16 candidates, each running a baseline plus two economics arms plus up to two mutation attempts
    // against a ~45s wall / ~148 CPU-s suite.
    maxRunMs: 8 * 60 * 60_000,
  },

  /**
   * Calibration of the instrument (2026-08-29).
   *
   * Not a repository experiment. It clones nothing and measures nothing about DiffCI's selector - it
   * asks whether the laboratory's own guarantees hold in the environment that produces evidence:
   *
   *   a hanging child is killed at the bound
   *   a child that prints a green summary and THEN hangs is never green
   *   a child whose grandchild outlives it is still bounded
   *   exit status outranks any parsed count
   *   coloured output does not hide a failure
   *
   * Cheap enough to run before trusting any future verdict, which is the point: a minutes-long
   * synthetic run rather than another multi-hour repository that happens to look wrong.
   */
  "harness-calibration": {
    id: "harness-calibration",
    description: "Run the harness calibration suite inside the canonical Linux environment.",
    mode: "calibrate",
    expectedAgentIntegrity: "sha512-mj4GQJLruQTexqkKybpP4KXGSZsqfs5vD7UbeMPQzV5LfqaR7HwKjuT2l7AP6o8yzyk3fC9aeGSWuyk3+CH7Kw==",
    // Seconds of real work. A ceiling this low is itself a check: if calibration cannot finish in ten
    // minutes, something is wrong with the environment rather than with the tests.
    maxRunMs: 10 * 60_000,
  },

  /**
   * EXTERNAL VALIDATION TARGET #1 (2026-08-30). See docs/external-target-01-selection.md.
   *
   * fastify/fastify, named by ChatGPT after the external-validation protocol was frozen at `04750a3`
   * and before the repository was cloned or any Fastify-specific DiffCI data existed. This is the first
   * repository in this corpus that did not participate in developing the rule being tested.
   *
   * REGISTRATION, NOT NEW CAPABILITY. A caller names a job and never supplies commands, so a new target
   * needs an entry here to be runnable at all. The gate, the predictor, `effectiveSelection()` and the
   * output parsers are untouched at `910969f`, which is the implementation under test.
   *
   * ITS RUNNER IS NEITHER VITEST NOR JEST. Fastify runs `borp`, a node:test runner. That was not known
   * when the target was named, and it is not a reason to adjust anything: the frozen protocol says a
   * calibration that cannot read a test-file count returns NO_ASSESSMENT, and NO_ASSESSMENT is a result
   * rather than permission to derive the denominator some other way.
   */
  "fastify-qualification": {
    id: "fastify-qualification",
    description: "Qualify fastify/fastify in the canonical Linux environment, and calibrate cost-per-test.",
    mode: "qualify",
    repository: "fastify/fastify",
    pinnedHeadSha: "1beaf7e72d24b2fc63a02a7f5806772a00e45454",
    // Agent generation B, as every economics-phase job uses. An eligibility assessment that ends in a
    // measurement needs the comparator's selection exposed, and only B exposes it.
    expectedAgentIntegrity: "sha512-mlNTeKlrkt6TqWBGi9e5O/QM90t7vXpmwyBIly5Mm1glHzRotWmV1s9A1PK3zJIwfntHEgh8S/t3lRJOYucN8g==",
    maxRunMs: 3 * 60 * 60_000,
  },

  /**
   * EXTERNAL VALIDATION TARGET #2 (2026-08-30). See docs/external-target-02-selection.md.
   *
   * date-fns/date-fns, named after target #1 closed as NOT_QUALIFIED, and before this repository was
   * cloned or any date-fns DiffCI data existed. It was named earlier than fastify - as the third
   * fallback in the repository #3 selection - but has been observed exactly as little: no selection
   * ratio and no economics figure for it has ever been seen.
   *
   * Registration, not new capability. `910969f` remains the implementation under test.
   */
  "date-fns-qualification": {
    id: "date-fns-qualification",
    description: "Qualify date-fns/date-fns in the canonical Linux environment, and calibrate cost-per-test.",
    mode: "qualify",
    repository: "date-fns/date-fns",
    pinnedHeadSha: "18cbd436f1428d0f45f89f710df65f62546c42f0",
    expectedAgentIntegrity: "sha512-mlNTeKlrkt6TqWBGi9e5O/QM90t7vXpmwyBIly5Mm1glHzRotWmV1s9A1PK3zJIwfntHEgh8S/t3lRJOYucN8g==",
    maxRunMs: 3 * 60 * 60_000,
  },

  /**
   * EXTERNAL VALIDATION TARGET #4 (2026-08-30). See docs/external-target-04-selection.md.
   *
   * axios/axios, named before its configuration was inspected. The first external target to pass the
   * structural checks: single package, root-executable, vitest (a runner both parsers read), and
   * explicit-file addressable.
   *
   * COVERAGE WAS VERIFIED BEFORE THIS JOB EXISTED, because defect #13 was a green qualification over 5%
   * of a repository. The unit universe is 58 files by three independent counts - the git tree at this
   * sha, the working tree after clone, and `vitest list --project unit` - and a single named path
   * collects exactly one file. If this run reports anything other than 58, the coverage assumption is
   * wrong and the verdict is not to be believed, whatever colour it is.
   */
  "axios-qualification": {
    id: "axios-qualification",
    description: "Qualify axios/axios in the canonical Linux environment, and calibrate cost-per-test.",
    mode: "qualify",
    repository: "axios/axios",
    pinnedHeadSha: "fede1d1562e308077da7994305d63fb7722b66ac",
    expectedAgentIntegrity: "sha512-mlNTeKlrkt6TqWBGi9e5O/QM90t7vXpmwyBIly5Mm1glHzRotWmV1s9A1PK3zJIwfntHEgh8S/t3lRJOYucN8g==",
    maxRunMs: 3 * 60 * 60_000,
  },

  /**
   * EXTERNAL VALIDATION TARGET #5 (2026-08-30), and the LAST of the initial external sequence.
   * See docs/external-target-05-selection.md.
   *
   * immerjs/immer, named before its configuration was inspected. The second target to clear the
   * structural gates: single package, root-executable, vitest, explicit-file addressable.
   *
   * Coverage verified before this job existed, per defect #13: the universe is 23 files by three
   * independent counts - git tree at this sha, working tree after clone, and `vitest list`. A run
   * reporting anything else means the coverage assumption is wrong and the verdict is not to be
   * believed, whatever colour it is.
   *
   * If this target stops before a prediction, the sequence STOPS rather than selecting a sixth. An
   * unbounded search for a repository that passes the gates is a search with a hidden denominator.
   */
  "immer-qualification": {
    id: "immer-qualification",
    description: "Qualify immerjs/immer in the canonical Linux environment, and calibrate cost-per-test.",
    mode: "qualify",
    repository: "immerjs/immer",
    pinnedHeadSha: "061c2425e1c9dff89e4e4189d42af1b7839dfe0a",
    expectedAgentIntegrity: "sha512-mlNTeKlrkt6TqWBGi9e5O/QM90t7vXpmwyBIly5Mm1glHzRotWmV1s9A1PK3zJIwfntHEgh8S/t3lRJOYucN8g==",
    maxRunMs: 3 * 60 * 60_000,
  },

  /**
   * immer OBSERVATION ONLY. No mutation, no economics arms.
   *
   * The step the external sequence has never reached before. It produces exactly the three inputs the
   * frozen prediction rule needs - the comparator's selection count, DiffCI's selection count, and the
   * measured joint analysis CPU - and nothing that would reveal the answer.
   *
   * `observeOnly` is what keeps the experiment falsifiable: the reproduce pipeline would otherwise run
   * the economics arms as a side effect of mutating, which would mean seeing the measurement before the
   * prediction was committed.
   */
  "immer-observation": {
    id: "immer-observation",
    description: "Observation only for immerjs/immer: selection counts and analysis CPU, no economics.",
    mode: "reproduce",
    observeOnly: true,
    repository: "immerjs/immer",
    pinnedHeadSha: "061c2425e1c9dff89e4e4189d42af1b7839dfe0a",
    commits: 25,
    expectedAgentIntegrity: "sha512-mlNTeKlrkt6TqWBGi9e5O/QM90t7vXpmwyBIly5Mm1glHzRotWmV1s9A1PK3zJIwfntHEgh8S/t3lRJOYucN8g==",
    mutate: {
      install: ["corepack", "yarn", "install", "--frozen-lockfile"],
      testModule: "node_modules/vitest/vitest.mjs",
      testArgs: ["run"],
      maxAttempts: 2,
      timeoutMs: 900_000,
    },
    // Observation only - a clone, an install and 25 analyses. Nothing executes a test suite.
    maxRunMs: 2 * 60 * 60_000,
  },

  /**
   * immer ECONOMICS - the measurement that answers a frozen POSITIVE prediction.
   *
   * The prediction was sealed at `bae2d00` (docs/immer-prediction-frozen.md) BEFORE this job existed:
   * +129.67 CPU-s incremental, from observation alone. Nothing here may be changed to agree with it.
   *
   * Same repository, same pinned commit, same agent generation, same commands as `immer-observation`
   * and `immer-qualification`. The accounting is unchanged and is the one the pre-registration fixed:
   *
   *   Incremental = C_comparator - (C_diffci_selected + C_joint_analysis)
   *
   * with joint analysis charged ENTIRELY to DiffCI, which is generous to the comparator. Gross versus
   * FULL stays secondary.
   *
   * If this measures negative the outcome is FALSE_POSITIVE_ELIGIBILITY, immer becomes development-set
   * evidence, and the predictor is NOT repaired against immer and re-run on immer.
   */
  /**
   * THE ADDRESSABILITY SURVEY (2026-08-30). See docs/addressability-survey-preregistration.md.
   *
   * Not a repository experiment and not a DiffCI measurement. It asks how often the assessment can be
   * reached at all, over a frame fixed before any repository was inspected, and where it stops when it
   * cannot.
   *
   * Runs unattended in the canonical container so the survey does not depend on an interactive session
   * staying alive. It clones each frame entry itself rather than using the pinned-clone machinery,
   * because the subject is 40 repositories rather than one.
   *
   * NOTHING IN THE APPARATUS MAY CHANGE WHILE THIS RUNS. The survey measures the product at `af3b355`;
   * a fix applied midway would mean the repositories evaluated before and after it are no longer the
   * same experiment, and the resulting rate would describe neither.
   */
  "addressability-survey": {
    id: "addressability-survey",
    description: "Addressability survey over the frozen frame: which gate stops each repository, and why.",
    mode: "survey",
    expectedAgentIntegrity: "sha512-mlNTeKlrkt6TqWBGi9e5O/QM90t7vXpmwyBIly5Mm1glHzRotWmV1s9A1PK3zJIwfntHEgh8S/t3lRJOYucN8g==",
    // 40 clones plus registry and GitHub lookups. Structural inspection only - nothing installs
    // dependencies or executes a test suite at this stage.
    maxRunMs: 4 * 60 * 60_000,
  },

  "immer-economics": {
    id: "immer-economics",
    description: "Compute measurement for immerjs/immer under agent B - out-of-sample test of a frozen POSITIVE prediction.",
    mode: "reproduce",
    repository: "immerjs/immer",
    pinnedHeadSha: "061c2425e1c9dff89e4e4189d42af1b7839dfe0a",
    commits: 25,
    expectedAgentIntegrity: "sha512-mlNTeKlrkt6TqWBGi9e5O/QM90t7vXpmwyBIly5Mm1glHzRotWmV1s9A1PK3zJIwfntHEgh8S/t3lRJOYucN8g==",
    mutate: {
      install: ["corepack", "yarn", "install", "--frozen-lockfile"],
      // No build: immer's source suite went green with no build stage in immer-qualify-01.
      testModule: "node_modules/vitest/vitest.mjs",
      testArgs: ["run"],
      maxAttempts: 2,
      timeoutMs: 900_000,
    },
    // 25 candidates, each a baseline plus two economics arms plus up to two mutation attempts against
    // a ~5s wall / ~15 CPU-s suite. Far cheaper per candidate than vue, but the install dominates.
    maxRunMs: 6 * 60 * 60_000,
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
  if (!job.repository) throw new Error(`job "${job.id}" has mode "${job.mode}" and names no repository`);
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
  if (!job.repository) throw new Error(`job "${job.id}" has mode "${job.mode}" and names no repository`);
  return ["run", "dogfood:qualify", "--", "--only", job.repository, "--clone-depth", "0", "--write"];
}

/**
 * Calibration-pass argv.
 *
 * Runs the harness's own calibration suite INSIDE the canonical environment. The suite exercises the
 * same process-execution primitive qualification uses, so what it measures is this harness's bounding
 * behaviour on this platform - not Node's in general, and not the developer host's.
 *
 * It exists because `zod-qualify-01` ran for three hours inside a stage believed to be bounded at
 * twenty-five minutes, and the only place that discrepancy has ever been observed is Linux/node22 in a
 * container. A refutation obtained on a Windows laptop has no authority there.
 */
export function calibrateArgv(): string[] {
  return ["run", "test:calibration"];
}

/** Where the qualification verdict is written inside the container. */
export const CORPUS_DEFINITION_PATH = "scripts/dogfood-corpus.json";

/** Where the survey writes its facts, adjudications and funnel inside the container. */
export const SURVEY_OUT = `${WORKSPACE}/survey`;
/** The frozen frame, shipped inside the source tarball so the run cannot silently re-resolve it. */
export const SURVEY_FRAME_PATH = "docs/evidence/survey/frame-ranks-1-40.json";

/**
 * Addressability-survey argv.
 *
 * The frame is a path into the source tarball rather than a URL, so a re-run measures the same 40
 * entries even if the upstream ranking moves. A survey whose frame can drift is not reproducible.
 */
export function surveyArgv(): string[] {
  return ["run", "survey", "--", "--frame", SURVEY_FRAME_PATH, "--out", SURVEY_OUT, "--work", `${SURVEY_OUT}/clones`];
}

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
  // Same reason as requireMutationCommands: an absent repository would put the string "undefined" into
  // the filter, and the mutation pass would then silently match no candidates and complete successfully.
  if (!job.repository) throw new Error(`job "${job.id}" has mode "${job.mode}" and names no repository`);
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
    ...(mutate.build ? ["--build", mutate.build.join("|")] : []),
    "--install", mutate.install.join("|"),
    "--test-module", mutate.testModule,
    "--test-args", mutate.testArgs.join("|"),
  ];
}
