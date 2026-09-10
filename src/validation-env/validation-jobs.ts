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
/** Where DiffCI own source is unpacked in the container. Mirrors the DO constant. */
export const DIFFCI_DIR = "/opt/diffci";
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
  mode: "reproduce" | "qualify" | "calibrate" | "survey" | "density" | "observe-pairs" | "ci-reproduce" | "language-qualification";
  /**
   * Universe-sanity expectations, checked in the canonical environment BEFORE the suite qualification.
   * Present only on apparatus-qualification jobs. See docs/apparatus-qualification-gen-c.md.
   */
  universe?: { expectedTestCount: number; forbiddenPrefixes: string[] };
  /** Sealed pair list for observe-pairs jobs. Defaults to the MECHANISM_PROOF_01 five. */
  /** Refuse to run unless the container is the QUALIFIED apparatus of this generation. */
  requiresApparatus?: "gen-c";
  /** Register the repository in the corpus registry before qualifying it (frame-continuation repos). */
  registerBeforeQualify?: boolean;
  /** Frame file for a survey job. Defaults to the frozen ranks 1-40. */
  surveyFramePath?: string;
  pairsPath?: string;
  /** Require every pair sharing a head to produce an IDENTICAL report - observation determinism. */
  assertIdenticalRepeats?: boolean;
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
  /** Hand-transcribed reference plan for this job. Defaults to the CI_REPRODUCTION_01 plan. */
  referencePlan?: string;
  /** R3 qualification: run the reference arm only and never invoke the inference engine. */
  referenceOnly?: boolean;
}

const JOBS: Record<string, ValidationJob> = {
  "vue-go-qualification-v1": {
    id: "vue-go-qualification-v1",
    description: "Cloudflare-only qualification of Vue test-utils and Go chi with observer 0.1.1, full/subset timings and controlled faults.",
    mode: "language-qualification",
    expectedAgentIntegrity: "sha512-hVSGB09NQww115gTpqOB2lCVjETCxQXErsyvDEJ2lKXbt5BZ/VRMCzZ+R/IZE9P40HtPQ7ADWrKpUrUF+iwsNg==",
    maxRunMs: 30 * 60_000,
  },
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

  /**
   * ADDRESSABILITY SURVEY, gates 5 and 6 (2026-08-30).
   *
   * The six entries that passed the structural gates in survey-01. Each is pinned at the head sha the
   * survey itself recorded, so the repository qualified is the one the survey classified - not whatever
   * is on the default branch when this runs.
   *
   * Commands come from the frozen facts, NOT from a fresh inspection. Where the harness cannot carry a
   * documented script across - node flags, environment variables - the corpus entry records exactly what
   * was lost, because a red baseline caused by a missing flag is an apparatus limit and must not be
   * reported as a property of the repository.
   */
  "survey-qualify-prettier": {
    id: "survey-qualify-prettier",
    description: "Survey gate 5-6: qualify prettier/prettier in the canonical Linux environment.",
    mode: "qualify",
    repository: "prettier/prettier",
    pinnedHeadSha: "18c4dfb01d61c53a63f9c30ee2257631ed1c5994",
    expectedAgentIntegrity: "sha512-mlNTeKlrkt6TqWBGi9e5O/QM90t7vXpmwyBIly5Mm1glHzRotWmV1s9A1PK3zJIwfntHEgh8S/t3lRJOYucN8g==",
    maxRunMs: 3 * 60 * 60_000,
  },

  "survey-qualify-webpack": {
    id: "survey-qualify-webpack",
    description: "Survey gate 5-6: qualify webpack/webpack in the canonical Linux environment.",
    mode: "qualify",
    repository: "webpack/webpack",
    pinnedHeadSha: "17fa705afbd6bf80a4a3e3b5ea90b18bea0bec32",
    expectedAgentIntegrity: "sha512-mlNTeKlrkt6TqWBGi9e5O/QM90t7vXpmwyBIly5Mm1glHzRotWmV1s9A1PK3zJIwfntHEgh8S/t3lRJOYucN8g==",
    maxRunMs: 3 * 60 * 60_000,
  },

  "survey-qualify-eslint-config-prettier": {
    id: "survey-qualify-eslint-config-prettier",
    description: "Survey gate 5-6: qualify prettier/eslint-config-prettier in the canonical Linux environment.",
    mode: "qualify",
    repository: "prettier/eslint-config-prettier",
    pinnedHeadSha: "bd6e6171434c7b34dec3dd0f325aab792c126ec6",
    expectedAgentIntegrity: "sha512-mlNTeKlrkt6TqWBGi9e5O/QM90t7vXpmwyBIly5Mm1glHzRotWmV1s9A1PK3zJIwfntHEgh8S/t3lRJOYucN8g==",
    maxRunMs: 3 * 60 * 60_000,
  },

  "survey-qualify-ts-jest": {
    id: "survey-qualify-ts-jest",
    description: "Survey gate 5-6: qualify kulshekhar/ts-jest in the canonical Linux environment.",
    mode: "qualify",
    repository: "kulshekhar/ts-jest",
    pinnedHeadSha: "b1a97ac485711377e01e72bac8b115e41a1c17ba",
    expectedAgentIntegrity: "sha512-mlNTeKlrkt6TqWBGi9e5O/QM90t7vXpmwyBIly5Mm1glHzRotWmV1s9A1PK3zJIwfntHEgh8S/t3lRJOYucN8g==",
    maxRunMs: 3 * 60 * 60_000,
  },

  "survey-qualify-css-loader": {
    id: "survey-qualify-css-loader",
    description: "Survey gate 5-6: qualify webpack/css-loader in the canonical Linux environment.",
    mode: "qualify",
    repository: "webpack/css-loader",
    pinnedHeadSha: "be04ec290ee57bafbc75f5936c1f6a2532681b49",
    expectedAgentIntegrity: "sha512-mlNTeKlrkt6TqWBGi9e5O/QM90t7vXpmwyBIly5Mm1glHzRotWmV1s9A1PK3zJIwfntHEgh8S/t3lRJOYucN8g==",
    maxRunMs: 3 * 60 * 60_000,
  },

  "survey-qualify-cross-env": {
    id: "survey-qualify-cross-env",
    description: "Survey gate 5-6: qualify kentcdodds/cross-env in the canonical Linux environment.",
    mode: "qualify",
    repository: "kentcdodds/cross-env",
    pinnedHeadSha: "9951937a7d3d4a1ea7bd2ce3133bcfb687125813",
    expectedAgentIntegrity: "sha512-mlNTeKlrkt6TqWBGi9e5O/QM90t7vXpmwyBIly5Mm1glHzRotWmV1s9A1PK3zJIwfntHEgh8S/t3lRJOYucN8g==",
    maxRunMs: 3 * 60 * 60_000,
  },

  /**
   * SURVEY ECONOMICS (2026-08-30) - the five that passed all six gates.
   *
   * Interpretation criteria were frozen at `39a3db3` BEFORE these jobs existed, so no threshold here
   * can be chosen with a result in view.
   *
   * Same accounting as every economics run before them, unchanged:
   *
   *   Incremental = C_comparator - (C_diffci_selected + C_joint_analysis)
   *
   * with joint analysis charged ENTIRELY to DiffCI. Gross versus FULL is reported alongside rather
   * than instead, because gross, overhead and net are three separate quantities and collapsing them
   * is how a 300-CPU-second saving and a 1-second saving come to look alike.
   *
   * Commands are identical to the ones each repository qualified with. webpack is absent: it is
   * `not qualified`, and it stays undiagnosed for the duration of this experiment.
   */
  "survey-economics-prettier": {
    id: "survey-economics-prettier",
    description: "Compute measurement for prettier/prettier under agent B - survey economics.",
    mode: "reproduce",
    repository: "prettier/prettier",
    pinnedHeadSha: "18c4dfb01d61c53a63f9c30ee2257631ed1c5994",
    commits: 25,
    expectedAgentIntegrity: "sha512-mlNTeKlrkt6TqWBGi9e5O/QM90t7vXpmwyBIly5Mm1glHzRotWmV1s9A1PK3zJIwfntHEgh8S/t3lRJOYucN8g==",
    mutate: {
      install: ["corepack","yarn","install","--immutable"],
      testModule: "node_modules/jest/bin/jest.js",
      testArgs: [],
      maxAttempts: 2,
      timeoutMs: 900_000,
    },
    // 1557 files, 35278 tests, ~805 CPU-s and 214s wall per full run - the heaviest workload in the set and the one carrying the most weight. Sharded, because 25 candidates at roughly five suite runs each is over seven hours unsharded.
    maxRunMs: 8 * 60 * 60_000,
  },

  "survey-economics-ts-jest": {
    id: "survey-economics-ts-jest",
    description: "Compute measurement for kulshekhar/ts-jest under agent B - survey economics.",
    mode: "reproduce",
    repository: "kulshekhar/ts-jest",
    pinnedHeadSha: "b1a97ac485711377e01e72bac8b115e41a1c17ba",
    commits: 25,
    expectedAgentIntegrity: "sha512-mlNTeKlrkt6TqWBGi9e5O/QM90t7vXpmwyBIly5Mm1glHzRotWmV1s9A1PK3zJIwfntHEgh8S/t3lRJOYucN8g==",
    mutate: {
      install: ["npm","ci","--no-audit","--no-fund"],
      testModule: "node_modules/jest/bin/jest.js",
      testArgs: ["-c=jest.config.ts"],
      maxAttempts: 2,
      timeoutMs: 900_000,
    },
    // 20 files, 358 tests, ~260 CPU-s and 153s wall per full run.
    maxRunMs: 8 * 60 * 60_000,
  },

  "survey-economics-css-loader": {
    id: "survey-economics-css-loader",
    description: "Compute measurement for webpack/css-loader under agent B - survey economics.",
    mode: "reproduce",
    repository: "webpack/css-loader",
    pinnedHeadSha: "be04ec290ee57bafbc75f5936c1f6a2532681b49",
    commits: 25,
    expectedAgentIntegrity: "sha512-mlNTeKlrkt6TqWBGi9e5O/QM90t7vXpmwyBIly5Mm1glHzRotWmV1s9A1PK3zJIwfntHEgh8S/t3lRJOYucN8g==",
    mutate: {
      install: ["npm","ci","--no-audit","--no-fund"],
      testModule: "node_modules/jest/bin/jest.js",
      testArgs: [],
      maxAttempts: 2,
      timeoutMs: 900_000,
    },
    // 12 files, 625 tests, ~58 CPU-s per full run. NODE_ENV=test is still not passed - the same apparatus limit recorded at qualification, unchanged here.
    maxRunMs: 8 * 60 * 60_000,
  },

  "survey-economics-eslint-config-prettier": {
    id: "survey-economics-eslint-config-prettier",
    description: "Compute measurement for prettier/eslint-config-prettier under agent B - survey economics.",
    mode: "reproduce",
    repository: "prettier/eslint-config-prettier",
    pinnedHeadSha: "bd6e6171434c7b34dec3dd0f325aab792c126ec6",
    commits: 25,
    expectedAgentIntegrity: "sha512-mlNTeKlrkt6TqWBGi9e5O/QM90t7vXpmwyBIly5Mm1glHzRotWmV1s9A1PK3zJIwfntHEgh8S/t3lRJOYucN8g==",
    mutate: {
      install: ["corepack","yarn","install","--immutable"],
      testModule: "node_modules/jest/bin/jest.js",
      testArgs: [],
      maxAttempts: 2,
      timeoutMs: 900_000,
    },
    // 4 files, 463 tests, ~32 CPU-s per full run. Expected to be economically marginal or negative; run unchanged, because excluding it on size after seeing the qualification numbers is exactly the adjustment the criteria forbid.
    maxRunMs: 8 * 60 * 60_000,
  },

  "survey-economics-cross-env": {
    id: "survey-economics-cross-env",
    description: "Compute measurement for kentcdodds/cross-env under agent B - survey economics.",
    mode: "reproduce",
    repository: "kentcdodds/cross-env",
    pinnedHeadSha: "9951937a7d3d4a1ea7bd2ce3133bcfb687125813",
    commits: 25,
    expectedAgentIntegrity: "sha512-mlNTeKlrkt6TqWBGi9e5O/QM90t7vXpmwyBIly5Mm1glHzRotWmV1s9A1PK3zJIwfntHEgh8S/t3lRJOYucN8g==",
    mutate: {
      install: ["npm","ci","--no-audit","--no-fund"],
      testModule: "node_modules/vitest/vitest.mjs",
      testArgs: ["run"],
      maxAttempts: 2,
      timeoutMs: 900_000,
    },
    // 5 files, 63 tests, 3.50 CPU-s per full run - smaller than DiffCI's own per-candidate analysis cost on immer. Expected negative, and that is a wanted result: it locates the break-even boundary rather than invalidating anything.
    maxRunMs: 8 * 60 * 60_000,
  },

  /**
   * POST-RESULT DIAGNOSTIC runs (2026-08-30). NOT replacements.
   *
   * The economics runs se-css-loader-01, se-eslint-config-prettier-01 and se-cross-env-01 each
   * observed 25 candidates cleanly and were then refused by the `no-candidates` guard: across all 75
   * observations, not one decision was SELECTIVE with a non-empty selection. Those runs are preserved
   * exactly as they failed.
   *
   * That is already a result about selection applicability - the realised optimisation opportunity is
   * zero, so incremental economics are negative once analysis is charged, without any mutation being
   * needed to show it. What is NOT established is WHY DiffCI declined to narrow.
   *
   * These jobs answer only that. observeOnly, so nothing executes a suite and no economics arm runs;
   * the corpus rows carry decision.mode, decision.reason and selected/total for all 25 candidates,
   * which the failed runs never got to collect. Commands, commit, agent and configuration are
   * identical to the economics jobs - only the stopping point differs.
   */
  "survey-observe-css-loader": {
    id: "survey-observe-css-loader",
    description: "Diagnostic observation for webpack/css-loader: decisions and reasons only, no economics.",
    mode: "reproduce",
    observeOnly: true,
    repository: "webpack/css-loader",
    pinnedHeadSha: "be04ec290ee57bafbc75f5936c1f6a2532681b49",
    commits: 25,
    expectedAgentIntegrity: "sha512-mlNTeKlrkt6TqWBGi9e5O/QM90t7vXpmwyBIly5Mm1glHzRotWmV1s9A1PK3zJIwfntHEgh8S/t3lRJOYucN8g==",
    mutate: {
      install: ["npm","ci","--no-audit","--no-fund"],
      testModule: "node_modules/jest/bin/jest.js",
      testArgs: [],
      maxAttempts: 2,
      timeoutMs: 900_000,
    },
    // A clone, an install and 25 analyses. Nothing executes a test suite.
    maxRunMs: 2 * 60 * 60_000,
  },

  "survey-observe-eslint-config-prettier": {
    id: "survey-observe-eslint-config-prettier",
    description: "Diagnostic observation for prettier/eslint-config-prettier: decisions and reasons only, no economics.",
    mode: "reproduce",
    observeOnly: true,
    repository: "prettier/eslint-config-prettier",
    pinnedHeadSha: "bd6e6171434c7b34dec3dd0f325aab792c126ec6",
    commits: 25,
    expectedAgentIntegrity: "sha512-mlNTeKlrkt6TqWBGi9e5O/QM90t7vXpmwyBIly5Mm1glHzRotWmV1s9A1PK3zJIwfntHEgh8S/t3lRJOYucN8g==",
    mutate: {
      install: ["corepack","yarn","install","--immutable"],
      testModule: "node_modules/jest/bin/jest.js",
      testArgs: [],
      maxAttempts: 2,
      timeoutMs: 900_000,
    },
    // A clone, an install and 25 analyses. Nothing executes a test suite.
    maxRunMs: 2 * 60 * 60_000,
  },

  "survey-observe-cross-env": {
    id: "survey-observe-cross-env",
    description: "Diagnostic observation for kentcdodds/cross-env: decisions and reasons only, no economics.",
    mode: "reproduce",
    observeOnly: true,
    repository: "kentcdodds/cross-env",
    pinnedHeadSha: "9951937a7d3d4a1ea7bd2ce3133bcfb687125813",
    commits: 25,
    expectedAgentIntegrity: "sha512-mlNTeKlrkt6TqWBGi9e5O/QM90t7vXpmwyBIly5Mm1glHzRotWmV1s9A1PK3zJIwfntHEgh8S/t3lRJOYucN8g==",
    mutate: {
      install: ["npm","ci","--no-audit","--no-fund"],
      testModule: "node_modules/vitest/vitest.mjs",
      testArgs: ["run"],
      maxAttempts: 2,
      timeoutMs: 900_000,
    },
    // A clone, an install and 25 analyses. Nothing executes a test suite.
    maxRunMs: 2 * 60 * 60_000,
  },

  /**
   * TEST-TO-PRODUCTION CONNECTIVITY across the frozen 40 (2026-08-30).
   *
   * Prettier selected zero tests with a healthy graph: 5 changed files reached 105 affected source
   * files, but 1,419 of its 1,464 test files contain no import at all - they call a global injected
   * through jest's setupFiles. A file-level import graph cannot map a test that imports nothing.
   *
   * This asks whether that is an outlier or the norm, which is now a candidate ICP variable. It needs
   * a clone per repository and NO install, because graph construction reads the repository's own
   * sources - which is what makes forty repositories affordable.
   */
  "mapping-density-survey": {
    id: "mapping-density-survey",
    description: "Test-to-production connectivity across the frozen 40: import density and mapping density.",
    mode: "density",
    expectedAgentIntegrity: "sha512-mlNTeKlrkt6TqWBGi9e5O/QM90t7vXpmwyBIly5Mm1glHzRotWmV1s9A1PK3zJIwfntHEgh8S/t3lRJOYucN8g==",
    // Forty clones and forty graph builds. Prettier's graph took 8 s; the largest here may take more.
    maxRunMs: 4 * 60 * 60_000,
  },

  /**
   * COMPUTE_PROOF_V1 repository gate (2026-08-30). See docs/compute-proof-v1-preregistration.md.
   *
   * typescript-eslint was selected mechanically at `1b84b07` - highest mapping density among the two
   * qualifiers. `twoGreenBaselines` is a REQUIRED criterion and is not yet established: the
   * addressability survey classified this repository MONOREPO_SCOPE_UNSUPPORTED on a structural
   * heuristic, and its documented test command is an nx orchestrator.
   *
   * If it does not produce two green baselines it FAILS eligibility and the sealed rule advances to
   * jestjs/jest. That is a mechanical consequence, not a later choice, and no nx-specific handling is
   * added to help it pass.
   *
   * Pinned at the candidate head so qualification and any subsequent observation describe one tree.
   */
  "tseslint-qualification": {
    id: "tseslint-qualification",
    description: "COMPUTE_PROOF_V1 gate: qualify typescript-eslint against its own documented nx test command.",
    mode: "qualify",
    repository: "typescript-eslint/typescript-eslint",
    pinnedHeadSha: "a2fccae39c7cb1e516a29b1c746b7767bffa03e2",
    expectedAgentIntegrity: "sha512-mlNTeKlrkt6TqWBGi9e5O/QM90t7vXpmwyBIly5Mm1glHzRotWmV1s9A1PK3zJIwfntHEgh8S/t3lRJOYucN8g==",
    // A pnpm install across 19 packages plus two full nx runs over 15 projects.
    maxRunMs: 3 * 60 * 60_000,
  },

  /**
   * COMPUTE_PROOF_V1 repository gate, second candidate (2026-08-30).
   *
   * Reached mechanically: typescript-eslint failed twoGreenBaselines when its pnpm postinstall could
   * not load three Nx plugins, so the sealed rule at `1b84b07` advanced here without intervention.
   * The >=30% mapping threshold is NOT revisited - Jest's 38.3% was known before the rule was sealed,
   * and raising it now because the 99.7% candidate was eliminated is exactly the outcome-dependent
   * change the protocol prevents.
   *
   * Jest's documented `jest` script is a direct runner invocation, so the substitution question that
   * dominated typescript-eslint does not arise here.
   */
  "jest-qualification": {
    id: "jest-qualification",
    description: "COMPUTE_PROOF_V1 gate: qualify jestjs/jest against its own documented jest script.",
    mode: "qualify",
    repository: "jestjs/jest",
    pinnedHeadSha: "be425a0b0e3bd60a74e4a7e350aa38c63a2d25ef",
    expectedAgentIntegrity: "sha512-mlNTeKlrkt6TqWBGi9e5O/QM90t7vXpmwyBIly5Mm1glHzRotWmV1s9A1PK3zJIwfntHEgh8S/t3lRJOYucN8g==",
    // A yarn install across a large workspace plus TWO full runs of a 1195-file suite that includes
    // e2e. Prettier's 1557-file suite took 442 s for both baselines; Jest's e2e tests spawn processes
    // and are far slower per file, so this is deliberately generous rather than tuned.
    maxRunMs: 6 * 60 * 60_000,
  },

  /**
   * MECHANISM_PROOF_01 observation (2026-08-30). See docs/mechanism-proof-01-preregistration.md.
   *
   * The claim under test is narrow and different from COMPUTE_PROOF_V1's: does there EXIST a workload
   * where DiffCI safely saves compute. kulshekhar/ts-jest was selected mechanically at `6590e0c` -
   * 85.0% mapping density, 40 test files, 77 test-to-production edges, already green twice in this
   * environment at 260.22 CPU-s.
   *
   * Pinned at `b1a97ac4`, the exact tree those baselines were established on, so qualification and
   * observation describe one tree. The five candidate pairs are ancestors of it and come from the
   * source tarball rather than from `git log`.
   *
   * OBSERVATION ONLY. No mutation, no economics arm, no suite execution. If it yields zero
   * SELECTIVE-nonempty the sealed rule ends the experiment there - no threshold change, no other
   * commit, no move to another repository.
   */
  /**
   * MECHANISM_PROOF_01 mutation. See docs/mechanism-proof-01-mutation-protocol.md, frozen before any
   * mutation result existed.
   *
   * Same five sealed pairs, same pinned tree, same agent. It re-observes them because dogfood-mutate
   * needs the per-commit agent reports - which carry the selected-test identities - and those were
   * never collected out of `tsjest-observe-01`. The re-observation is checked against the frozen
   * classifications at `ddc6151`; divergence is a defect, not something to absorb.
   *
   * The mutate block is copied verbatim from `survey-economics-ts-jest`, which established the two
   * green baselines on this same tree at 260.22 CPU-s. Nothing about the execution recipe is tuned
   * for this experiment.
   */
  /**
   * APPARATUS QUALIFICATION - analyser generation C (`5fb0183`, defect 17 fixed).
   *
   * `89fc236` is frozen and stays frozen: it is evidence about generation B. Generation C changed what
   * DiffCI believes the test universe IS, so it must earn qualification independently rather than
   * inherit B verdict. See docs/apparatus-qualification-gen-c.md.
   *
   * The chain: pinned clone -> canonical environment -> universe sanity -> install/build -> repeated
   * green baselines. Universe sanity runs FIRST because there is no point measuring how reliably a
   * suite goes green if DiffCI models the wrong set of executable tests.
   *
   * ts-jest is the target because b1a97ac4 is the tree where the 20-vs-40 error was found and can
   * therefore be checked against ground truth. NO candidate pair is observed and NOTHING is mutated -
   * in particular not candidate 5, which is now a known success case and has no business inside a
   * qualification run.
   */
  "apparatus-qualify-gen-c": {
    id: "apparatus-qualify-gen-c",
    description: "Apparatus qualification for analyser generation C: universe sanity + repeated green baselines.",
    mode: "qualify",
    repository: "kulshekhar/ts-jest",
    pinnedHeadSha: "b1a97ac485711377e01e72bac8b115e41a1c17ba",
    // Generation C. MUST differ from generation B sha512-mlNTeKlr..., or the run would be measuring
    // the old analyser under a new label - the exact trap defect 18 set.
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    universe: {
      // jest.config.ts declares testMatch <rootDir>/src/**/*.spec.ts, which matches exactly 20.
      expectedTestCount: 20,
      forbiddenPrefixes: ["e2e", "examples", "presets", "scripts", "website"],
    },
    maxRunMs: 8 * 60 * 60_000,
  },

  /**
   * OBSERVATION DETERMINISM - the last link of the generation-C qualification chain.
   *
   * Repeated DISCOVERY returning identical paths (proved by apparatus-qualify-gen-c) does not imply
   * repeated OBSERVATION returning identical selections: discovery could be stable while selection
   * varied. This observes ONE pair TWICE in one container and requires the two reports to agree.
   *
   * The pair is the pinned tree own HEAD~1..HEAD, chosen mechanically and verified NOT to be among the
   * five MECHANISM_PROOF_01 candidates - in particular not candidate 5. WHAT it selects is never
   * interpreted and never compared against the sealed experiment; the only question is run 1 == run 2.
   */
  /**
   * E1 screening over the FRAME CONTINUATION, ranks 41-140.
   *
   * The frozen 40-entry frame was exhausted mechanically (0 eligible). The continuation rule frozen at
   * `ad4b4f6` - BEFORE any rank >= 41 was resolved - traverses the same third-party ordering from rank
   * 41 and stops at 5 eligible previously unmeasured repositories.
   *
   * This job answers E1 (addressability) ONLY. It runs no `observe`, no `mutate`, and no density
   * survey: learning during screening that a repository is favourable to DiffCI would destroy the
   * independence the draw exists to protect, as surely as choosing one on purpose.
   *
   * It screens the whole 100-entry window rather than stopping at the 5th eligible, because the survey
   * never skips and its per-entry cost is metadata plus a shallow clone. The COUNT stop applies to the
   * expensive gate, qualification, which is run afterwards sequentially in rank order.
   */
  /**
   * E2 GREEN gate for the frame continuation, ranks 41-140.
   *
   * Registered for all ten E1+E3 passers so the rank order is fixed in code rather than chosen at run
   * time - but they are RUN sequentially in rank order and the sequence STOPS at the fifth GREEN. A
   * repository after that point is never qualified, even though the apparatus is warm: it must stay
   * unseen beyond E1/E3.
   *
   * Qualification only. No observe, no mutate, no density, no selection inspection. Nothing here can
   * learn whether a repository is favourable to DiffCI.
   */
  "e2-lint-staged": {
    id: "e2-lint-staged",
    description: "E2 green gate, frame rank 46: lint-staged/lint-staged.",
    mode: "qualify",
    repository: "lint-staged/lint-staged",
    // The tree E1 actually screened, not whatever HEAD later moves to.
    pinnedHeadSha: "d0c1517b61f4805a319ae416f50b1d5bdf3e137f",
    requiresApparatus: "gen-c",
    registerBeforeQualify: true,
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    maxRunMs: 4 * 60 * 60_000,
  },

  "e2-html-webpack-plugin": {
    id: "e2-html-webpack-plugin",
    description: "E2 green gate, frame rank 58: jantimon/html-webpack-plugin.",
    mode: "qualify",
    repository: "jantimon/html-webpack-plugin",
    // The tree E1 actually screened, not whatever HEAD later moves to.
    pinnedHeadSha: "cf9c7012003b8d71783d6c2d72f357616957b99c",
    requiresApparatus: "gen-c",
    registerBeforeQualify: true,
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    maxRunMs: 4 * 60 * 60_000,
  },

  "e2-eslint-plugin-promise": {
    id: "e2-eslint-plugin-promise",
    description: "E2 green gate, frame rank 62: eslint-community/eslint-plugin-promise.",
    mode: "qualify",
    repository: "eslint-community/eslint-plugin-promise",
    // The tree E1 actually screened, not whatever HEAD later moves to.
    pinnedHeadSha: "e73585efc03ddf17df0273fa3b8dad0b66c51168",
    requiresApparatus: "gen-c",
    registerBeforeQualify: true,
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    maxRunMs: 4 * 60 * 60_000,
  },

  "e2-postcss-loader": {
    id: "e2-postcss-loader",
    description: "E2 green gate, frame rank 75: webpack/postcss-loader.",
    mode: "qualify",
    repository: "webpack/postcss-loader",
    // The tree E1 actually screened, not whatever HEAD later moves to.
    pinnedHeadSha: "ed3e1f7592a5fea2eb0da2475a3675ceb9371a47",
    requiresApparatus: "gen-c",
    registerBeforeQualify: true,
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    maxRunMs: 4 * 60 * 60_000,
  },

  "e2-eslint-plugin-vue": {
    id: "e2-eslint-plugin-vue",
    description: "E2 green gate, frame rank 80: vuejs/eslint-plugin-vue.",
    mode: "qualify",
    repository: "vuejs/eslint-plugin-vue",
    // The tree E1 actually screened, not whatever HEAD later moves to.
    pinnedHeadSha: "f3a027627472216e17e812f5324059f45d156298",
    requiresApparatus: "gen-c",
    registerBeforeQualify: true,
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    maxRunMs: 4 * 60 * 60_000,
  },

  "e2-rollup-plugin-typescript2": {
    id: "e2-rollup-plugin-typescript2",
    description: "E2 green gate, frame rank 112: ezolenko/rollup-plugin-typescript2.",
    mode: "qualify",
    repository: "ezolenko/rollup-plugin-typescript2",
    // The tree E1 actually screened, not whatever HEAD later moves to.
    pinnedHeadSha: "4cff90bbe88a6747d5a0eb52d300cb8bed505277",
    requiresApparatus: "gen-c",
    registerBeforeQualify: true,
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    maxRunMs: 4 * 60 * 60_000,
  },

  "e2-extract-text-webpack-plugin": {
    id: "e2-extract-text-webpack-plugin",
    description: "E2 green gate, frame rank 115: webpack-contrib/extract-text-webpack-plugin.",
    mode: "qualify",
    repository: "webpack-contrib/extract-text-webpack-plugin",
    // The tree E1 actually screened, not whatever HEAD later moves to.
    pinnedHeadSha: "bc6f9f8f61d708352ea89fd4fc9764ce1e4de409",
    requiresApparatus: "gen-c",
    registerBeforeQualify: true,
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    maxRunMs: 4 * 60 * 60_000,
  },

  "e2-jest-dom": {
    id: "e2-jest-dom",
    description: "E2 green gate, frame rank 116: testing-library/jest-dom.",
    mode: "qualify",
    repository: "testing-library/jest-dom",
    // The tree E1 actually screened, not whatever HEAD later moves to.
    pinnedHeadSha: "3782c78b3dc9824675afe0cb8f1722f8c96f494d",
    requiresApparatus: "gen-c",
    registerBeforeQualify: true,
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    maxRunMs: 4 * 60 * 60_000,
  },

  "e2-ant-design": {
    id: "e2-ant-design",
    description: "E2 green gate, frame rank 119: ant-design/ant-design.",
    mode: "qualify",
    repository: "ant-design/ant-design",
    // The tree E1 actually screened, not whatever HEAD later moves to.
    pinnedHeadSha: "c5dbf3f09b406586d5ce6ce0a3d634d1a07b4f04",
    requiresApparatus: "gen-c",
    registerBeforeQualify: true,
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    maxRunMs: 4 * 60 * 60_000,
  },

  "e2-vue-loader": {
    id: "e2-vue-loader",
    description: "E2 green gate, frame rank 120: vuejs/vue-loader.",
    mode: "qualify",
    repository: "vuejs/vue-loader",
    // The tree E1 actually screened, not whatever HEAD later moves to.
    pinnedHeadSha: "698636508e08f5379a57eaf086b5ff533af8e051",
    requiresApparatus: "gen-c",
    registerBeforeQualify: true,
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    maxRunMs: 4 * 60 * 60_000,
  },

  /**
   * E1 screening over the SECOND continuation window, ranks 141-240.
   *
   * Ranks 41-140 yielded 4 GREEN of 10 E1 passers - one short of N = 5. The frozen continuation rule
   * stops at the COUNT, not at a rank ceiling, so the traversal continues from 141 under the same
   * third-party ordering. No rule changed, N was not lowered, and no RED was revisited.
   *
   * E1 only: no observe, no mutate, no density.
   */
  /**
   * E2 green gate for the SECOND continuation window, ranks 141-240.
   *
   * Registered for all 18 E1+E3 passers so rank order is fixed in code, run sequentially in rank order,
   * stopping at GREEN #5 - which needs ONE more green. Repositories after that point are never
   * qualified even with a warm apparatus; they stay unseen beyond E1/E3.
   */
  "e2-eslint-plugin-jest": {
    id: "e2-eslint-plugin-jest",
    description: "E2 green gate, frame rank 153: jest-community/eslint-plugin-jest.",
    mode: "qualify",
    repository: "jest-community/eslint-plugin-jest",
    pinnedHeadSha: "c7bf004e00271f88bc8dd2b6a0e378dfc33f02da",
    requiresApparatus: "gen-c",
    registerBeforeQualify: true,
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    maxRunMs: 4 * 60 * 60_000,
  },

  "e2-rollup-plugin-postcss": {
    id: "e2-rollup-plugin-postcss",
    description: "E2 green gate, frame rank 160: egoist/rollup-plugin-postcss.",
    mode: "qualify",
    repository: "egoist/rollup-plugin-postcss",
    pinnedHeadSha: "71593d9f4698ce564482b86cc2fa7f69626e8b8a",
    requiresApparatus: "gen-c",
    registerBeforeQualify: true,
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    maxRunMs: 4 * 60 * 60_000,
  },

  "e2-rollup-plugin-peer-deps-external": {
    id: "e2-rollup-plugin-peer-deps-external",
    description: "E2 green gate, frame rank 165: pmowrer/rollup-plugin-peer-deps-external.",
    mode: "qualify",
    repository: "pmowrer/rollup-plugin-peer-deps-external",
    pinnedHeadSha: "8b92f9723a0ba09a6479c077482cbdc59a2dd050",
    requiresApparatus: "gen-c",
    registerBeforeQualify: true,
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    maxRunMs: 4 * 60 * 60_000,
  },

  "e2-copy-webpack-plugin": {
    id: "e2-copy-webpack-plugin",
    description: "E2 green gate, frame rank 176: webpack/copy-webpack-plugin.",
    mode: "qualify",
    repository: "webpack/copy-webpack-plugin",
    pinnedHeadSha: "08b3a640f054c8414b48f450baa39e7da4f77695",
    requiresApparatus: "gen-c",
    registerBeforeQualify: true,
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    maxRunMs: 4 * 60 * 60_000,
  },

  "e2-tslint-config-prettier": {
    id: "e2-tslint-config-prettier",
    description: "E2 green gate, frame rank 178: prettier/tslint-config-prettier.",
    mode: "qualify",
    repository: "prettier/tslint-config-prettier",
    pinnedHeadSha: "dba2b6c555877cbeb828ae940a49c68fbd778066",
    requiresApparatus: "gen-c",
    registerBeforeQualify: true,
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    maxRunMs: 4 * 60 * 60_000,
  },

  "e2-webpack-bundle-analyzer": {
    id: "e2-webpack-bundle-analyzer",
    description: "E2 green gate, frame rank 188: webpack/webpack-bundle-analyzer.",
    mode: "qualify",
    repository: "webpack/webpack-bundle-analyzer",
    pinnedHeadSha: "eab49ca192ee61a2d0c703ba38f9b2fec052efbd",
    requiresApparatus: "gen-c",
    registerBeforeQualify: true,
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    maxRunMs: 4 * 60 * 60_000,
  },

  "e2-optimize-css-assets-webpack-plugin": {
    id: "e2-optimize-css-assets-webpack-plugin",
    description: "E2 green gate, frame rank 189: NMFR/optimize-css-assets-webpack-plugin.",
    mode: "qualify",
    repository: "NMFR/optimize-css-assets-webpack-plugin",
    pinnedHeadSha: "d0bf176a01b144cd8736f01c409dd1214ecfbe8c",
    requiresApparatus: "gen-c",
    registerBeforeQualify: true,
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    maxRunMs: 4 * 60 * 60_000,
  },

  "e2-clean-webpack-plugin": {
    id: "e2-clean-webpack-plugin",
    description: "E2 green gate, frame rank 191: johnagan/clean-webpack-plugin.",
    mode: "qualify",
    repository: "johnagan/clean-webpack-plugin",
    pinnedHeadSha: "0207fe42de3da90c30ad492fd1dbe042dec2623b",
    requiresApparatus: "gen-c",
    registerBeforeQualify: true,
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    maxRunMs: 4 * 60 * 60_000,
  },

  "e2-minimizer-webpack-plugin": {
    id: "e2-minimizer-webpack-plugin",
    description: "E2 green gate, frame rank 195: webpack/minimizer-webpack-plugin.",
    mode: "qualify",
    repository: "webpack/minimizer-webpack-plugin",
    pinnedHeadSha: "6f34b21109cd75e433c47a958cc17aaacbe0d211",
    requiresApparatus: "gen-c",
    registerBeforeQualify: true,
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    maxRunMs: 4 * 60 * 60_000,
  },

  "e2-redux": {
    id: "e2-redux",
    description: "E2 green gate, frame rank 196: reduxjs/redux.",
    mode: "qualify",
    repository: "reduxjs/redux",
    pinnedHeadSha: "71606661ac515bdd64c199a6bb508401c7cf736f",
    requiresApparatus: "gen-c",
    registerBeforeQualify: true,
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    maxRunMs: 4 * 60 * 60_000,
  },

  "e2-stylelint": {
    id: "e2-stylelint",
    description: "E2 green gate, frame rank 197: stylelint/stylelint.",
    mode: "qualify",
    repository: "stylelint/stylelint",
    pinnedHeadSha: "cabcfb818938dbd39b0f8e3a883e7c526ecbfe3a",
    requiresApparatus: "gen-c",
    registerBeforeQualify: true,
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    maxRunMs: 4 * 60 * 60_000,
  },

  "e2-cheerio": {
    id: "e2-cheerio",
    description: "E2 green gate, frame rank 209: cheeriojs/cheerio.",
    mode: "qualify",
    repository: "cheeriojs/cheerio",
    pinnedHeadSha: "ad87bd8f298d68e9fd1f8c214bf1657d178d2a90",
    requiresApparatus: "gen-c",
    registerBeforeQualify: true,
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    maxRunMs: 4 * 60 * 60_000,
  },

  "e2-codecov-node": {
    id: "e2-codecov-node",
    description: "E2 green gate, frame rank 211: codecov/codecov-node.",
    mode: "qualify",
    repository: "codecov/codecov-node",
    pinnedHeadSha: "7c698b77e3b04abc24a8bbf2e0606d6f77cdba21",
    requiresApparatus: "gen-c",
    registerBeforeQualify: true,
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    maxRunMs: 4 * 60 * 60_000,
  },

  "e2-tsdx": {
    id: "e2-tsdx",
    description: "E2 green gate, frame rank 224: jaredpalmer/tsdx.",
    mode: "qualify",
    repository: "jaredpalmer/tsdx",
    pinnedHeadSha: "5b1aa0d67788bfb5ae46e6845e2e4e07c1c73e99",
    requiresApparatus: "gen-c",
    registerBeforeQualify: true,
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    maxRunMs: 4 * 60 * 60_000,
  },

  "e2-react-redux": {
    id: "e2-react-redux",
    description: "E2 green gate, frame rank 225: reduxjs/react-redux.",
    mode: "qualify",
    repository: "reduxjs/react-redux",
    pinnedHeadSha: "16f1a91eb2cc3817bf63753e8c90e528a9f0580c",
    requiresApparatus: "gen-c",
    registerBeforeQualify: true,
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    maxRunMs: 4 * 60 * 60_000,
  },

  "e2-karma-webpack": {
    id: "e2-karma-webpack",
    description: "E2 green gate, frame rank 229: webpack-contrib/karma-webpack.",
    mode: "qualify",
    repository: "webpack-contrib/karma-webpack",
    pinnedHeadSha: "ee740b90896e51aa741949f929437642553c1aa8",
    requiresApparatus: "gen-c",
    registerBeforeQualify: true,
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    maxRunMs: 4 * 60 * 60_000,
  },

  "e2-vuex": {
    id: "e2-vuex",
    description: "E2 green gate, frame rank 236: vuejs/vuex.",
    mode: "qualify",
    repository: "vuejs/vuex",
    pinnedHeadSha: "bd907467b8392d6671bb115738285ff7f63d0cf6",
    requiresApparatus: "gen-c",
    registerBeforeQualify: true,
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    maxRunMs: 4 * 60 * 60_000,
  },

  "e2-rollup-plugin-uglify": {
    id: "e2-rollup-plugin-uglify",
    description: "E2 green gate, frame rank 240: TrySound/rollup-plugin-uglify.",
    mode: "qualify",
    repository: "TrySound/rollup-plugin-uglify",
    pinnedHeadSha: "60df3a9e7f9e8354afa614e40c9cb1a1bf0fefbc",
    requiresApparatus: "gen-c",
    registerBeforeQualify: true,
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    maxRunMs: 4 * 60 * 60_000,
  },

  /**
   * GENERATION_C_01 - observation of the sealed target. Step 6.
   *
   * Observes the ONE sealed target pair, derived mechanically from
   * docs/evidence/generation-c-target.json. The other four candidates are deliberately NOT observed:
   * observing all five and choosing afterwards is exactly the cherry-picking the sealed target rule
   * exists to prevent.
   *
   * OBSERVATION ONLY. No mutation, no economics arm, no suite execution. Whatever DiffCI decides -
   * SELECTIVE, FULL or REFUSED - is the result, reported as measured.
   */
  /**
   * GENERATION_C_01 mutation of the sealed target. Protocol frozen in
   * docs/generation-c-mutation-protocol.md before any mutation result existed.
   *
   * Re-observes the sealed target to regenerate the per-commit agent report dogfood-mutate needs, then
   * mutates. Commands are the ones derived at E2 registration from the repository own manifest.
   */
  /**
   * MECHANISM_ISOLATION_01. Protocol frozen at 614b385 before the pool was drawn.
   *
   * One target, drawn from an 18-entry pool of changed-implementation / ZERO-changed-test candidates.
   * Runs the full, comparator, DiffCI and DIRECT-ONLY arms against one mutation. The direct-only arm
   * is the isolating one: only it can distinguish dependency reasoning from running the diff.
   */
  /**
   * MECHANISM_ISOLATION_02 - the final bespoke mechanism experiment. Protocol frozen at c08de74.
   *
   * Asks the detection half MI-01 could not: does a graph-reached test actually change the DETECTION
   * outcome? Four arms, of which DIRECT-ONLY is the discriminator.
   */
  /**
   * CI_REPRODUCTION_02 - the canonical Linux run, mandatory before any reproduction claim.
   *
   * Attempt 1 ran on Windows under node 24 and is preserved as DIVERGED with that limitation
   * recorded; its reference-arm test failures are NOT attributable to the repository.
   */
  "ci-reproduce-eslint": {
    id: "ci-reproduce-eslint",
    description: "CI_REPRODUCTION_05: reference vs inference arms on the sealed R3-qualified target.",
    mode: "ci-reproduce",
    repository: "eslint/eslint",
    pinnedHeadSha: "2417cad57d7d1bc4cf3ecf0f0575cfb10ff2011c",
    requiresApparatus: "gen-c",
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    referencePlan: "docs/evidence/ci-reproduction-05-eslint-reference-plan.json",
    maxRunMs: 4 * 60 * 60_000,
  },

  "r3-qualify-babel-loader": {
    id: "r3-qualify-babel-loader",
    description: "CI_REPRODUCTION_SAMPLE_01 member 5, R3: babel/babel-loader reference arm only.",
    mode: "ci-reproduce",
    repository: "babel/babel-loader",
    pinnedHeadSha: "778e7c54daa57e30c1d676e243c77f7c00a766d8",
    requiresApparatus: "gen-c",
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    referencePlan: "docs/evidence/ci-reproduction-05-babel-loader-reference-plan.json",
    referenceOnly: true,
    maxRunMs: 2 * 60 * 60_000,
  },

  "ci-reproduce-babel-loader": {
    id: "ci-reproduce-babel-loader",
    description: "CI_REPRODUCTION_SAMPLE_01 member 5: reference vs inference arms on babel/babel-loader.",
    mode: "ci-reproduce",
    repository: "babel/babel-loader",
    pinnedHeadSha: "778e7c54daa57e30c1d676e243c77f7c00a766d8",
    requiresApparatus: "gen-c",
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    referencePlan: "docs/evidence/ci-reproduction-05-babel-loader-reference-plan.json",
    maxRunMs: 3 * 60 * 60_000,
  },

  "r3-qualify-babel": {
    id: "r3-qualify-babel",
    description: "CI_REPRODUCTION_SAMPLE_01 member 4, R3: babel/babel reference arm only, cross-job artifact reconstruction.",
    mode: "ci-reproduce",
    repository: "babel/babel",
    pinnedHeadSha: "3fbcec1ccbe9ebfa5a8575bc88afadd061899bd5",
    requiresApparatus: "gen-c",
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    referencePlan: "docs/evidence/ci-reproduction-05-babel-reference-plan.json",
    referenceOnly: true,
    maxRunMs: 3 * 60 * 60_000,
  },

  "ci-reproduce-babel": {
    id: "ci-reproduce-babel",
    description: "CI_REPRODUCTION_SAMPLE_01 member 4: reference vs inference arms on babel/babel. Carries REFERENCE_DEVIATION.",
    mode: "ci-reproduce",
    repository: "babel/babel",
    pinnedHeadSha: "3fbcec1ccbe9ebfa5a8575bc88afadd061899bd5",
    requiresApparatus: "gen-c",
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    referencePlan: "docs/evidence/ci-reproduction-05-babel-reference-plan.json",
    maxRunMs: 4 * 60 * 60_000,
  },

  "r3-qualify-webpack": {
    id: "r3-qualify-webpack",
    description: "CI_REPRODUCTION_SAMPLE_01 member 3, R3: webpack/webpack reference arm only.",
    mode: "ci-reproduce",
    repository: "webpack/webpack",
    pinnedHeadSha: "ebd3be47689e8e5b1335517dfd680d025ade1f4c",
    requiresApparatus: "gen-c",
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    referencePlan: "docs/evidence/ci-reproduction-05-webpack-reference-plan.json",
    referenceOnly: true,
    maxRunMs: 3 * 60 * 60_000,
  },

  "ci-reproduce-webpack": {
    id: "ci-reproduce-webpack",
    description: "CI_REPRODUCTION_SAMPLE_01 member 3: reference vs inference arms on webpack/webpack.",
    mode: "ci-reproduce",
    repository: "webpack/webpack",
    pinnedHeadSha: "ebd3be47689e8e5b1335517dfd680d025ade1f4c",
    requiresApparatus: "gen-c",
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    referencePlan: "docs/evidence/ci-reproduction-05-webpack-reference-plan.json",
    maxRunMs: 4 * 60 * 60_000,
  },

  "r3-qualify-jest": {
    id: "r3-qualify-jest",
    description: "CI_REPRODUCTION_SAMPLE_01 member 2, R3: does jestjs/jest complete in the canonical container, reference arm only.",
    mode: "ci-reproduce",
    repository: "jestjs/jest",
    pinnedHeadSha: "9ab14feccd6c15fec1334dbcb03a53a079d153d3",
    requiresApparatus: "gen-c",
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    referencePlan: "docs/evidence/ci-reproduction-05-jest-reference-plan.json",
    referenceOnly: true,
    maxRunMs: 3 * 60 * 60_000,
  },

  "ci-reproduce-jest": {
    id: "ci-reproduce-jest",
    description: "CI_REPRODUCTION_SAMPLE_01 member 2: reference vs inference arms on jestjs/jest.",
    mode: "ci-reproduce",
    repository: "jestjs/jest",
    pinnedHeadSha: "9ab14feccd6c15fec1334dbcb03a53a079d153d3",
    requiresApparatus: "gen-c",
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    referencePlan: "docs/evidence/ci-reproduction-05-jest-reference-plan.json",
    maxRunMs: 4 * 60 * 60_000,
  },

  "r3-qualify-eslint": {
    id: "r3-qualify-eslint",
    description: "CI_REPRODUCTION_05 R3: does eslint/eslint complete in the canonical container, reference arm only.",
    mode: "ci-reproduce",
    repository: "eslint/eslint",
    pinnedHeadSha: "2417cad57d7d1bc4cf3ecf0f0575cfb10ff2011c",
    requiresApparatus: "gen-c",
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    referencePlan: "docs/evidence/ci-reproduction-05-eslint-reference-plan.json",
    referenceOnly: true,
    maxRunMs: 3 * 60 * 60_000,
  },

  "ci-reproduce-html-webpack-plugin": {
    id: "ci-reproduce-html-webpack-plugin",
    description: "CI_REPRODUCTION_02: reference vs inference arms in the canonical Linux environment.",
    mode: "ci-reproduce",
    repository: "jantimon/html-webpack-plugin",
    pinnedHeadSha: "cf9c7012003b8d71783d6c2d72f357616957b99c",
    requiresApparatus: "gen-c",
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    maxRunMs: 4 * 60 * 60_000,
  },

  "mi2-mutate-target": {
    id: "mi2-mutate-target",
    description: "MECHANISM_ISOLATION_02: mutate the drawn fix-subject no-test-edit target.",
    mode: "observe-pairs",
    repository: "jest-community/eslint-plugin-jest",
    pinnedHeadSha: "c7bf004e00271f88bc8dd2b6a0e378dfc33f02da",
    requiresApparatus: "gen-c",
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    pairsPath: "docs/evidence/mechanism-isolation-02-target-pair.json",
    mutate: {
      install: ["corepack", "yarn", "install", "--immutable"],
      build: ["corepack", "yarn", "run", "build"],
      testModule: "node_modules/jest/bin/jest.js",
      testArgs: [],
      maxAttempts: 2,
      timeoutMs: 900_000,
    },
    maxRunMs: 6 * 60 * 60_000,
  },

  "mi-mutate-target": {
    id: "mi-mutate-target",
    description: "MECHANISM_ISOLATION_01: mutate the drawn no-test-edit target, with the direct-only arm.",
    mode: "observe-pairs",
    repository: "jest-community/eslint-plugin-jest",
    pinnedHeadSha: "c7bf004e00271f88bc8dd2b6a0e378dfc33f02da",
    requiresApparatus: "gen-c",
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    pairsPath: "docs/evidence/mechanism-isolation-01-target-pair.json",
    mutate: {
      install: ["corepack", "yarn", "install", "--immutable"],
      build: ["corepack", "yarn", "run", "build"],
      testModule: "node_modules/jest/bin/jest.js",
      testArgs: [],
      maxAttempts: 2,
      timeoutMs: 900_000,
    },
    maxRunMs: 6 * 60 * 60_000,
  },

  "genc-mutate-target": {
    id: "genc-mutate-target",
    description: "GENERATION_C_01: mutate the sealed target under the frozen protocol.",
    mode: "observe-pairs",
    repository: "jest-community/eslint-plugin-jest",
    pinnedHeadSha: "c7bf004e00271f88bc8dd2b6a0e378dfc33f02da",
    requiresApparatus: "gen-c",
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    pairsPath: "docs/evidence/generation-c-target-pair.json",
    mutate: {
      install: ["corepack", "yarn", "install", "--immutable"],
      build: ["corepack", "yarn", "run", "build"],
      testModule: "node_modules/jest/bin/jest.js",
      testArgs: [],
      maxAttempts: 2,
      timeoutMs: 900_000,
    },
    maxRunMs: 6 * 60 * 60_000,
  },

  "genc-observe-target": {
    id: "genc-observe-target",
    description: "GENERATION_C_01: observe the sealed target pair. No mutation.",
    mode: "observe-pairs",
    repository: "jest-community/eslint-plugin-jest",
    pinnedHeadSha: "c7bf004e00271f88bc8dd2b6a0e378dfc33f02da",
    requiresApparatus: "gen-c",
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    pairsPath: "docs/evidence/generation-c-target-pair.json",
    // A clone and one analysis. Nothing installs dependencies or executes a test suite.
    maxRunMs: 2 * 60 * 60_000,
  },

  "survey-frame-continuation-2": {
    id: "survey-frame-continuation-2",
    description: "E1 addressability screening over frame ranks 141-240, under the generation-C apparatus.",
    mode: "survey",
    requiresApparatus: "gen-c",
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    surveyFramePath: "docs/evidence/survey/frame-ranks-141-240.json",
    maxRunMs: 8 * 60 * 60_000,
  },

  "survey-frame-continuation": {
    id: "survey-frame-continuation",
    description: "E1 addressability screening over frame ranks 41-140, under the generation-C apparatus.",
    mode: "survey",
    requiresApparatus: "gen-c",
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    surveyFramePath: "docs/evidence/survey/frame-ranks-41-140.json",
    maxRunMs: 8 * 60 * 60_000,
  },

  "apparatus-determinism-gen-c": {
    id: "apparatus-determinism-gen-c",
    description: "Apparatus qualification: repeated observation of one non-candidate pair must be identical.",
    mode: "observe-pairs",
    repository: "kulshekhar/ts-jest",
    pinnedHeadSha: "b1a97ac485711377e01e72bac8b115e41a1c17ba",
    expectedAgentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
    pairsPath: "docs/evidence/apparatus-determinism-pairs.json",
    assertIdenticalRepeats: true,
    // A clone and two analyses. Nothing installs dependencies or executes a suite.
    maxRunMs: 2 * 60 * 60_000,
  },

  "tsjest-mechanism-mutation": {
    id: "tsjest-mechanism-mutation",
    description: "MECHANISM_PROOF_01: mutate the five sealed ts-jest candidates under the frozen protocol.",
    mode: "observe-pairs",
    repository: "kulshekhar/ts-jest",
    pinnedHeadSha: "b1a97ac485711377e01e72bac8b115e41a1c17ba",
    expectedAgentIntegrity: "sha512-mlNTeKlrkt6TqWBGi9e5O/QM90t7vXpmwyBIly5Mm1glHzRotWmV1s9A1PK3zJIwfntHEgh8S/t3lRJOYucN8g==",
    mutate: {
      install: ["npm","ci","--no-audit","--no-fund"],
      testModule: "node_modules/jest/bin/jest.js",
      testArgs: ["-c=jest.config.ts"],
      maxAttempts: 2,
      timeoutMs: 900_000,
    },
    // Five candidates, each needing a baseline plus three arms, at ~153s wall per full run.
    maxRunMs: 8 * 60 * 60_000,
  },

  "tsjest-mechanism-observation": {
    id: "tsjest-mechanism-observation",
    description: "MECHANISM_PROOF_01: observe the five sealed ts-jest candidates. No mutation.",
    mode: "observe-pairs",
    repository: "kulshekhar/ts-jest",
    pinnedHeadSha: "b1a97ac485711377e01e72bac8b115e41a1c17ba",
    expectedAgentIntegrity: "sha512-mlNTeKlrkt6TqWBGi9e5O/QM90t7vXpmwyBIly5Mm1glHzRotWmV1s9A1PK3zJIwfntHEgh8S/t3lRJOYucN8g==",
    // A clone and five analyses. Nothing installs dependencies or executes a test suite.
    maxRunMs: 2 * 60 * 60_000,
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
/**
 * Register the repository in the corpus registry from its OWN manifest, under the frozen rule in
 * docs/e2-registration-rule.md. Reads package.json and lockfiles; executes nothing.
 */
export function registerArgv(job: ValidationJob): string[] {
  if (!job.repository) throw new Error(`job "${job.id}" has mode "${job.mode}" and names no repository`);
  return ["run", "corpus:register", "--", "--repo", PINNED_CLONE, "--source", job.repository, "--out", `${DIFFCI_DIR}/scripts/dogfood-corpus.json`, "--derivation", REGISTRATION_DERIVATION_OUT];
}

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
/** Where the density survey writes its rows and summary inside the container. */
export const DENSITY_OUT = `${WORKSPACE}/density`;

/**
 * Density-survey argv.
 *
 * Same frozen frame file as the addressability survey, from inside the source tarball, so both
 * surveys describe the same forty repositories rather than two drifting lists.
 */
/** The sealed MECHANISM_PROOF_01 candidate list, shipped inside the source tarball. */
export const PAIRS_PATH = "docs/evidence/mechanism-proof-pairs.json";

/**
 * Named-pair observation argv.
 *
 * The pair list is a path INTO THE SOURCE TARBALL, so the five candidates observed are the five
 * sealed at `07bc3d1` and cannot be re-derived from git log at run time. A candidate list that could
 * drift would make the pre-registration decorative.
 */
export function observePairsArgv(job?: ValidationJob): string[] {
  return [
    "run", "observe:pairs", "--",
    "--repo", PINNED_CLONE,
    "--pairs", job?.pairsPath ?? PAIRS_PATH,
    "--out", OBSERVED_CORPUS_PATH,
    "--reports", `${WORKSPACE}/reports`,
    ...(job?.assertIdenticalRepeats ? ["--assert-identical-repeats"] : []),
  ];
}

export const REGISTRATION_DERIVATION_OUT = `${WORKSPACE}/registration-derivation.json`;

export const CI_REPRODUCTION_OUT = `${WORKSPACE}/ci-reproduction`;

/**
 * CI_REPRODUCTION argv - two independently constructed arms, executed in the canonical Linux
 * environment. The Windows attempt 1 is preserved and is NOT used for repository correctness,
 * baseline CPU, savings or reproduction claims.
 */
export function ciReproduceArgv(job: ValidationJob): string[] {
  if (!job.repository) throw new Error(`job "${job.id}" names no repository`);
  return [
    "run", "ci:reproduce", "--",
    "--repository", job.repository,
    "--head", job.pinnedHeadSha ?? "",
    "--work", `${WORKSPACE}/ci-repro-work`,
    "--out", CI_REPRODUCTION_OUT,
    "--reference", job.referencePlan ?? "docs/evidence/ci-reproduction-01-reference-plan.json",
    // R3 qualification runs the reference arm ALONE. The engine must not see a candidate while its
    // eligibility is still being decided, or eligibility starts depending on whether DiffCI copes.
    ...(job.referenceOnly ? ["--reference-only"] : []),
  ];
}

export const UNIVERSE_OUT = `${WORKSPACE}/universe-sanity.json`;

/**
 * Universe-sanity argv. Refuses (exit 1) on any mismatch, so a discrepancy fails the RUN rather than
 * being recorded as a finding - an apparatus defect must never become an experimental result.
 */
export function universeArgv(job: ValidationJob): string[] {
  const u = job.universe;
  if (!u) throw new Error(`job "${job.id}" has no universe expectations`);
  return [
    "run", "qualify:universe", "--",
    "--repo", PINNED_CLONE,
    "--expect-tests", String(u.expectedTestCount),
    "--forbid-prefixes", u.forbiddenPrefixes.join(","),
    "--out", UNIVERSE_OUT,
  ];
}

export function densityArgv(): string[] {
  return ["run", "survey:density", "--", "--frame", SURVEY_FRAME_PATH, "--out", DENSITY_OUT, "--work", `${DENSITY_OUT}/clones`];
}

export function surveyArgv(job?: ValidationJob): string[] {
  // The frame is a path INTO THE SOURCE TARBALL, so which repositories are screened is fixed by the
  // committed frame file and cannot drift at run time.
  return ["run", "survey", "--", "--frame", job?.surveyFramePath ?? SURVEY_FRAME_PATH, "--out", SURVEY_OUT, "--work", `${SURVEY_OUT}/clones`];
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
