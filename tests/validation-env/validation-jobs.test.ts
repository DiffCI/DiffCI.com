/**
 * The reproduction job is only meaningful if it still describes the run it claims to reproduce.
 *
 * These tests read the FROZEN hono bundle from disk and assert the job matches it. That is the point:
 * a reproduction experiment whose inputs have quietly drifted from the original still produces a
 * confident-looking funnel, and the difference gets attributed to the operating system. The corpus has
 * already been bitten twice by exactly this shape of problem - an unwired `--build` flag that made two
 * runs byte-identical, and a contaminated results file - and both times the manifest is what caught it.
 */
import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";

import {
  MAX_SHARDS,
  PINNED_CLONE,
  SHARD_CORPUS_PATH,
  assignShard,
  buildJobCorpus,
  getValidationJob,
  isPinnedSha,
  isRepositorySlug,
  listValidationJobs,
  mutateArgv,
  observeArgv,
  qualifyArgv,
} from "../../src/validation-env/validation-jobs.js";
import { stepValidation } from "../../src/validation-env/cloudflare/validation-shard-do.js";

const repoRoot = resolve(dirname(import.meta.filename), "..", "..");

/** The corpus registry entry for a repository - the file qualification actually reads its commands from. */
interface CorpusEntry {
  source: string;
  install?: string[];
  build?: string[];
  testModule?: string;
  testArgs?: string[];
  lockfile?: string;
  universeVerification?: string;
}
function corpusEntry(source: string): CorpusEntry {
  const all = JSON.parse(readFileSync(join(repoRoot, "scripts", "dogfood-corpus.json"), "utf8")) as CorpusEntry[];
  const entry = all.find((e) => e.source === source);
  assert.ok(entry, `no corpus registry entry for ${source}`);
  return entry;
}
const FROZEN = join(repoRoot, ".dogfood", "frozen", "2026-08-28T15-17-45-366Z-honojs-hono-cc009a");

describe("the validation job allowlist", () => {
  it("refuses an unknown job rather than falling back to a default", () => {
    assert.equal(getValidationJob("does-not-exist"), undefined);
  });

  it("is not fooled by inherited Object properties", () => {
    // A plain `JOBS[id]` lookup answers "constructor" and "__proto__" with something truthy, and the
    // caller would then treat a function as a job specification.
    assert.equal(getValidationJob("__proto__"), undefined);
    assert.equal(getValidationJob("constructor"), undefined);
    assert.equal(getValidationJob("toString"), undefined);
  });

  it("pins every job to an unambiguous commit and repository", () => {
    for (const id of listValidationJobs()) {
      const job = getValidationJob(id)!;
      // Calibration measures the laboratory itself: it clones nothing, so it pins nothing.
      if (job.mode === "calibrate") { assert.equal(job.repository, undefined); assert.equal(job.pinnedHeadSha, undefined); continue; }
      // The survey names no repository either - its subject is a frozen frame of 40, and it clones each
      // entry itself. Pinning is enforced there by the committed frame file, not by this field.
      if (job.mode === "survey") { assert.equal(job.repository, undefined); assert.equal(job.pinnedHeadSha, undefined); continue; }
      // The density survey has the same shape: a frozen frame of 40, cloned by the pass itself.
      if (job.mode === "density") { assert.equal(job.repository, undefined); assert.equal(job.pinnedHeadSha, undefined); continue; }
      assert.ok(isPinnedSha(job.pinnedHeadSha!), `${id} must pin a full 40-hex sha`);
      assert.ok(isRepositorySlug(job.repository!), `${id} must name owner/name`);
      // `observe-pairs` carries no commit COUNT because its candidates are a sealed list in the source
      // tarball rather than N commits taken from `git log`. That is a stronger guarantee than a count,
      // not a weaker one: a count would re-derive the candidates at run time and could drift from the
      // draw the pre-registration froze.
      assert.ok(
        (job.commits ?? 0) > 0 || job.mode === "qualify" || job.mode === "observe-pairs",
        `${id} must observe at least one commit`,
      );
      assert.ok(job.maxRunMs > 0, `${id} must bound its own runtime`);
    }
  });
});

describe("input validators", () => {
  it("rejects shas that are short, uppercase, or not hex", () => {
    assert.equal(isPinnedSha("e2740d5a"), false);
    assert.equal(isPinnedSha("E2740D5A1BD0B4254E517E3AF8B60789284BC7BD"), false);
    assert.equal(isPinnedSha(`${"g".repeat(40)}`), false);
    assert.equal(isPinnedSha("e2740d5a1bd0b4254e517e3af8b60789284bc7bd"), true);
  });

  it("rejects repository slugs that could alter a clone URL", () => {
    assert.equal(isRepositorySlug("honojs/hono"), true);
    assert.equal(isRepositorySlug("honojs"), false);
    assert.equal(isRepositorySlug("honojs/hono; rm -rf /"), false);
    assert.equal(isRepositorySlug("honojs/hono&&whoami"), false);
    assert.equal(isRepositorySlug("../../etc/passwd"), false);
  });
});

describe("the hono reproduction matches the evidence it reproduces", () => {
  const job = getValidationJob("hono-reproduction")!;

  it("targets the head commit the frozen corpus was derived from", { skip: !existsSync(FROZEN) }, () => {
    const rows = readFileSync(join(FROZEN, "corpus.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { identity: { repository: string; headSha: string } });

    // The first observed row is the newest commit, which is where `git log` started.
    assert.equal(job.pinnedHeadSha, rows[0]!.identity.headSha);
    assert.equal(job.repository, rows[0]!.identity.repository);
    // Observing a different number of commits changes the denominator of the whole funnel.
    assert.equal(job.commits, rows.length);
  });

  it("uses the agent that produced the frozen evidence, byte for byte", { skip: !existsSync(FROZEN) }, () => {
    const rows = readFileSync(join(FROZEN, "corpus.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { identity: { agentIntegrity: string } });
    assert.equal(job.expectedAgentIntegrity, rows[0]!.identity.agentIntegrity);
  });

  it("replays the commands the frozen manifest recorded, not the ones the registry lists", { skip: !existsSync(FROZEN) }, () => {
    const manifest = JSON.parse(readFileSync(join(FROZEN, "manifest.json"), "utf8")) as {
      commands: { install: string[]; testModule: string; testArgs: string[] };
      maxAttempts: number;
      timeoutMs: number;
    };
    assert.deepEqual(job.mutate!.install, manifest.commands.install);
    assert.equal(job.mutate!.testModule, manifest.commands.testModule);
    assert.deepEqual(job.mutate!.testArgs, manifest.commands.testArgs);
    assert.equal(job.mutate!.maxAttempts, manifest.maxAttempts);
    assert.equal(job.mutate!.timeoutMs, manifest.timeoutMs);
  });
});

describe("the argv handed to the container", () => {
  const job = getValidationJob("hono-reproduction")!;

  it("labels the corpus with owner/name, because that string becomes the recorded repository identity", () => {
    // Regression guard for 2026-08-29. `dogfood-observe` writes `identity.repository` as the corpus
    // entry's `source` verbatim, and `dogfood-mutate` filters candidates on it. Setting `source` to the
    // pinned clone's PATH produced 25 observations labelled "/workspace/target-src", a `--repository
    // honojs/hono` filter that matched none of them, and a COMPLETE run with zero rows that reported
    // success in 30 seconds. Pinning is done by a git insteadOf rewrite instead, not by this string.
    const corpus = buildJobCorpus(job) as Array<{ source: string; commits: number }>;
    assert.equal(corpus.length, 1);
    assert.equal(corpus[0]!.source, job.repository);
    assert.notEqual(corpus[0]!.source, PINNED_CLONE, "a filesystem path here silently discards every candidate");
    assert.equal(corpus[0]!.commits, job.commits);
  });

  it("filters the mutation pass on the same string the corpus will be labelled with", () => {
    // The two must agree or every candidate is dropped without an error. This asserts the agreement
    // directly rather than trusting that both were updated together.
    const corpus = buildJobCorpus(job) as Array<{ source: string }>;
    const argv = mutateArgv(job, "/scratch", "/scratch/clone");
    assert.equal(argv[argv.indexOf("--repository") + 1], corpus[0]!.source);
  });

  it("passes the mutation pass the repository filter, without which other repositories are attempted against the wrong tree", () => {
    const argv = mutateArgv(job, "/workspace/tmp/diffci-dogfood-abc123", "/workspace/tmp/diffci-dogfood-abc123/_workspace_target_src");
    const index = argv.indexOf("--repository");
    assert.notEqual(index, -1);
    assert.equal(argv[index + 1], "honojs/hono");
  });

  it("encodes multi-word commands as the harness expects them", () => {
    const argv = mutateArgv(job, "/scratch", "/scratch/clone");
    assert.equal(argv[argv.indexOf("--install") + 1], "npm|install|--no-audit|--no-fund|--silent");
    assert.equal(argv[argv.indexOf("--test-args") + 1], "run");
  });

  it("keeps every observation-pass argument a fixed literal", () => {
    // Nothing request-derived may appear here; the container is not a remote shell.
    for (const arg of observeArgv()) {
      assert.equal(typeof arg, "string");
      assert.ok(arg.length > 0);
    }
    assert.ok(observeArgv().includes("dogfood"));
  });
});

describe("sharding a run across containers", () => {
  it("covers every candidate exactly once, whatever the shard count", () => {
    // The property that matters: a split must not lose or duplicate work. A lost candidate would
    // shrink the funnel's denominator silently, which reads as a cleaner result rather than a broken
    // experiment - the same failure shape as the empty run and the mislabelled corpus before it.
    for (const shardCount of [1, 2, 3, 4, 7, 8, 12]) {
      const owners = Array.from({ length: 22 }, (_unused, i) => assignShard(i, shardCount));
      assert.equal(owners.length, 22);
      for (const owner of owners) {
        assert.ok(owner >= 0 && owner < shardCount, `shard ${owner} out of range for ${shardCount}`);
      }
      const covered = new Set(owners.map((_o, i) => i));
      assert.equal(covered.size, 22, `${shardCount} shards must cover all 22 candidates`);
    }
  });

  it("balances candidates to within one, so no shard sets the wall clock alone", () => {
    // Round-robin rather than contiguous blocks: candidate cost varies by several multiples, and a
    // contiguous split lets one shard draw all the expensive ones.
    const shardCount = 4;
    const counts = new Array<number>(shardCount).fill(0);
    for (let i = 0; i < 22; i++) counts[assignShard(i, shardCount)]! += 1;
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, `unbalanced: ${counts.join(",")}`);
  });

  it("is deterministic, so a sharded run stays as re-runnable as an unsharded one", () => {
    const first = Array.from({ length: 22 }, (_unused, i) => assignShard(i, 5));
    const second = Array.from({ length: 22 }, (_unused, i) => assignShard(i, 5));
    assert.deepEqual(first, second);
  });

  it("puts everything in shard 0 when unsharded", () => {
    for (let i = 0; i < 22; i++) assert.equal(assignShard(i, 1), 0);
  });

  it("bounds the shard count, because each shard is a container that installs the target itself", () => {
    assert.ok(MAX_SHARDS >= 2 && MAX_SHARDS <= 32);
  });

  it("routes the mutation pass at the shard corpus, not the full one", () => {
    const job = getValidationJob("hono-reproduction")!;
    const argv = mutateArgv(job, "/scratch", "/scratch/clone", SHARD_CORPUS_PATH);
    assert.equal(argv[argv.indexOf("--corpus") + 1], SHARD_CORPUS_PATH);
    // ...and still defaults to the full corpus when no override is given.
    assert.notEqual(mutateArgv(job, "/scratch", "/scratch/clone")[argv.indexOf("--corpus") + 1], SHARD_CORPUS_PATH);
  });
});

describe("job modes", () => {
  it("gives every reproduce job the commands and commit count its pass needs", () => {
    for (const id of listValidationJobs()) {
      const job = getValidationJob(id)!;
      if (job.mode !== "reproduce") continue;
      assert.ok(job.mutate, `${id} is a reproduce job and must define mutation commands`);
      assert.ok((job.commits ?? 0) > 0, `${id} is a reproduce job and must say how many commits to observe`);
    }
  });

  it("refuses to build mutation argv for a qualification job, rather than emitting \"undefined\"", () => {
    const zod = getValidationJob("zod-qualification")!;
    assert.equal(zod.mode, "qualify");
    assert.throws(() => mutateArgv(zod, "/scratch", "/scratch/clone"), /defines no mutation commands/);
  });

  it("qualifies with a full clone, because a shallow one cannot answer what a build asks git", () => {
    const argv = qualifyArgv(getValidationJob("zod-qualification")!);
    assert.equal(argv[argv.indexOf("--clone-depth") + 1], "0");
    assert.equal(argv[argv.indexOf("--only") + 1], "colinhacks/zod");
    // --write is what turns a console verdict into a collectable artefact.
    assert.ok(argv.includes("--write"));
  });
});

describe("the zod mutation pass", () => {
  const job = getValidationJob("zod-mutation")!;

  it("passes the build the repository qualified with, or every baseline would be dirty", () => {
    // zod's tests import workspace package outputs. dogfood-mutate accepts --build, but an earlier
    // incarnation of that flag was never passed by its caller and silently made two runs identical.
    assert.deepEqual(job.mutate!.build, ["corepack", "pnpm", "build"]);
    const argv = mutateArgv(job, "/scratch", "/scratch/clone");
    assert.equal(argv[argv.indexOf("--build") + 1], "corepack|pnpm|build");
  });

  it("omits --build entirely for a repository that needs none", () => {
    // hono qualified without a build; emitting an empty --build would change what it runs.
    const hono = getValidationJob("hono-reproduction")!;
    assert.equal(hono.mutate!.build, undefined);
    assert.equal(mutateArgv(hono, "/scratch", "/scratch/clone").includes("--build"), false);
  });

  it("runs zod with the commands qualification actually used", () => {
    assert.deepEqual(job.mutate!.install, ["corepack", "pnpm", "install", "--frozen-lockfile"]);
    assert.equal(job.mutate!.testModule, "node_modules/vitest/vitest.mjs");
    assert.deepEqual(job.mutate!.testArgs, ["run"]);
  });

  it("generates candidates the same way the canonical hono evidence was generated", () => {
    assert.equal(job.commits, getValidationJob("hono-reproduction")!.commits);
  });
});

describe("agent generations cannot cross between safety and economics jobs", () => {
  const AGENT_A = "sha512-mj4GQJLruQTexqkKybpP4KXGSZsqfs5vD7UbeMPQzV5LfqaR7HwKjuT2l7AP6o8yzyk3fC9aeGSWuyk3+CH7Kw==";
  const AGENT_B = "sha512-mlNTeKlrkt6TqWBGi9e5O/QM90t7vXpmwyBIly5Mm1glHzRotWmV1s9A1PK3zJIwfntHEgh8S/t3lRJOYucN8g==";

  it("keeps the safety jobs pinned to agent A", () => {
    // These produced the frozen safety corpus. Running them under B would silently mix generations.
    for (const id of ["hono-reproduction", "zod-mutation"]) {
      assert.equal(getValidationJob(id)!.expectedAgentIntegrity, AGENT_A, `${id} must stay on agent A`);
    }
  });

  it("pins the economics jobs to agent B, which alone exposes the comparator's selection", () => {
    for (const id of ["hono-economics", "zod-economics"]) {
      assert.equal(getValidationJob(id)!.expectedAgentIntegrity, AGENT_B, `${id} must run on agent B`);
    }
  });

  it("keeps the two generations distinct, so the boundary is real rather than nominal", () => {
    assert.notEqual(AGENT_A, AGENT_B);
  });

  it("measures the same pinned commits as the safety runs, so the two phases are comparable", () => {
    assert.equal(getValidationJob("hono-economics")!.pinnedHeadSha, getValidationJob("hono-reproduction")!.pinnedHeadSha);
    assert.equal(getValidationJob("zod-economics")!.pinnedHeadSha, getValidationJob("zod-mutation")!.pinnedHeadSha);
  });

  it("carries zod's build into the economics job too, or every baseline would be dirty", () => {
    assert.deepEqual(getValidationJob("zod-economics")!.mutate!.build, ["corepack", "pnpm", "build"]);
    assert.equal(getValidationJob("hono-economics")!.mutate!.build, undefined);
  });
});

/**
 * External validation target #1.
 *
 * The value of this target is entirely in the fact that it was named before anything about it was
 * known. These assertions pin the facts that make that claim checkable later.
 */
describe("external validation target #1: fastify", () => {
  const AGENT_B = "sha512-mlNTeKlrkt6TqWBGi9e5O/QM90t7vXpmwyBIly5Mm1glHzRotWmV1s9A1PK3zJIwfntHEgh8S/t3lRJOYucN8g==";

  it("names the repository and the exact commit the assessment will be pinned to", () => {
    const job = getValidationJob("fastify-qualification")!;
    assert.equal(job.repository, "fastify/fastify");
    assert.equal(job.pinnedHeadSha, "1beaf7e72d24b2fc63a02a7f5806772a00e45454");
    assert.ok(isPinnedSha(job.pinnedHeadSha!), "an unpinned target observes whatever is on main that day");
  });

  it("runs on agent B, since an eligibility assessment ends in a comparator measurement", () => {
    assert.equal(getValidationJob("fastify-qualification")!.expectedAgentIntegrity, AGENT_B);
  });

  it("uses fastify's own documented unit script, and invents no file filters", () => {
    // borp reads .borp.yaml from the repository, so the file set is the repository's decision, not ours.
    const entry = corpusEntry("fastify/fastify");
    assert.equal(entry.testModule, "node_modules/borp/borp.js");
    assert.deepEqual(entry.testArgs, [], "bare borp - the committed config supplies the files");
    assert.deepEqual(entry.install, ["npm", "install", "--no-audit", "--no-fund"]);
    assert.equal(entry.build, undefined, "fastify's generated lib files are committed; unit tests need no build");
  });

  it("records that fastify has no lockfile rather than quietly assuming reproducibility", () => {
    // hono had the same weakness and the registry once wrongly claimed it had a committed lockfile.
    assert.match(corpusEntry("fastify/fastify").lockfile ?? "", /^NONE\./);
  });
});

describe("external validation target #2: date-fns", () => {
  it("pins the repository and commit the assessment will be tied to", () => {
    const job = getValidationJob("date-fns-qualification")!;
    assert.equal(job.repository, "date-fns/date-fns");
    assert.equal(job.pinnedHeadSha, "18cbd436f1428d0f45f89f710df65f62546c42f0");
  });

  it("uses the repository's own root vitest config, and invents no project filter", () => {
    // The root package.json has no scripts at all, so the root vitest.config.ts - projects: ["pkgs/*"] -
    // is the only repository-authored statement of "all the tests" there is. Narrowing to pkgs/core
    // would pre-screen the repository into a friendlier shape.
    const entry = corpusEntry("date-fns/date-fns");
    assert.equal(entry.testModule, "node_modules/vitest/vitest.mjs");
    assert.deepEqual(entry.testArgs, ["run"], "the same bare invocation hono received");
    assert.equal(entry.build, undefined, "core's exports point at src/index.ts, so nothing needs building");
  });

  it("installs from the committed lockfile, which this repository actually has", () => {
    assert.deepEqual(corpusEntry("date-fns/date-fns").install, ["corepack", "pnpm", "install", "--frozen-lockfile"]);
    assert.match(corpusEntry("date-fns/date-fns").lockfile ?? "", /^pnpm-lock\.yaml committed\./);
  });
});

/**
 * External validation target #4.
 *
 * The universe assertion is the one that matters: defect #13 was a green qualification over 5% of a
 * repository, so the expected file count is pinned here from three independent counts made before the
 * job existed. A run reporting anything else is not to be believed, whatever colour it is.
 */
describe("external validation target #4: axios", () => {
  it("pins the repository and commit", () => {
    const job = getValidationJob("axios-qualification")!;
    assert.equal(job.repository, "axios/axios");
    assert.equal(job.pinnedHeadSha, "fede1d1562e308077da7994305d63fb7722b66ac");
  });

  it("uses axios's own documented unit script, not the browser-launching default", () => {
    // Bare `vitest run` also runs the browser and browser-headless projects, which declare playwright
    // chromium/firefox/webkit - dependencies the validation contract forbids. Same rule applied to vue.
    const entry = corpusEntry("axios/axios");
    assert.deepEqual(entry.testArgs, ["run", "--project", "unit"]);
    assert.equal(entry.build, undefined, "unit tests import lib/ by relative path; no build needed");
  });

  it("installs from the committed lockfile", () => {
    assert.deepEqual(corpusEntry("axios/axios").install, ["npm", "ci", "--no-audit", "--no-fund"]);
  });

  it("records the independently established test universe, so a shortfall is detectable", () => {
    assert.match(corpusEntry("axios/axios").universeVerification ?? "", /58/);
  });
});

describe("external validation target #5: immer", () => {
  it("pins the repository and commit", () => {
    const job = getValidationJob("immer-qualification")!;
    assert.equal(job.repository, "immerjs/immer");
    assert.equal(job.pinnedHeadSha, "061c2425e1c9dff89e4e4189d42af1b7839dfe0a");
  });

  it("uses immer's documented test:src, not the default that builds and type-checks", () => {
    // `test` is `vitest run && yarn test:build && yarn test:flow`. test:build runs a SECOND vitest pass
    // against built artefacts, which is not the source unit suite.
    const entry = corpusEntry("immerjs/immer");
    assert.deepEqual(entry.testArgs, ["run"]);
    assert.equal(entry.build, undefined, "the source suite runs green on an unbuilt tree");
  });

  it("installs from the committed yarn lockfile", () => {
    assert.deepEqual(corpusEntry("immerjs/immer").install, ["corepack", "yarn", "install", "--frozen-lockfile"]);
  });

  it("records the independently established test universe, so a shortfall is detectable", () => {
    assert.match(corpusEntry("immerjs/immer").universeVerification ?? "", /23 files by three independent counts/);
  });
});

/**
 * The economics job must measure the SAME thing the frozen prediction was made about.
 *
 * A different commit, agent generation or test command would make the comparison meaningless while
 * still producing a number, which is the failure mode this whole corpus keeps rediscovering.
 */
describe("immer economics answers the prediction that was frozen", () => {
  const observation = getValidationJob("immer-observation")!;
  const economics = getValidationJob("immer-economics")!;

  it("measures the same repository at the same pinned commit", () => {
    assert.equal(economics.repository, observation.repository);
    assert.equal(economics.pinnedHeadSha, observation.pinnedHeadSha);
    assert.equal(economics.commits, observation.commits);
  });

  it("runs the same agent generation, so selections are comparable", () => {
    assert.equal(economics.expectedAgentIntegrity, observation.expectedAgentIntegrity);
  });

  it("executes the same commands the prediction's calibration was measured with", () => {
    assert.deepEqual(economics.mutate!.install, observation.mutate!.install);
    assert.deepEqual(economics.mutate!.testArgs, observation.mutate!.testArgs);
    assert.equal(economics.mutate!.testModule, observation.mutate!.testModule);
    assert.equal(economics.mutate!.build, undefined, "immer's source suite qualified with no build");
  });

  it("actually runs the arms - observeOnly here would silently produce no economics at all", () => {
    assert.equal(observation.observeOnly, true);
    assert.notEqual(economics.observeOnly, true);
  });
});

/**
 * Defect #16: a failed run must not destroy the evidence that explains why it failed.
 *
 * Prettier's 25 observations were lost this way - four hours of work discarded because `locate` refused
 * before `collect` ran, taking with it the one distribution the experiment existed to measure.
 */
describe("a failed run preserves its evidence", () => {
  const stepOnce = async (record: any, job: any, sandbox: any, bucket: any) =>
    stepValidation(record, { sandbox, bucket, job, now: () => 1_000 });

  const fakeSandbox = (files: Record<string, string>) => ({
    async readFile(path: string) {
      const content = files[path];
      if (content === undefined) throw new Error(`no such file: ${path}`);
      return { content };
    },
    async exec() {
      return { success: true, stdout: "", stderr: "", exitCode: 0 };
    },
    async writeFile() {},
  });

  const fakeBucket = () => {
    const written: Record<string, string> = {};
    return { written, async put(key: string, value: string) { written[key] = value; } };
  };

  it("routes a failure through preservation rather than straight to failed", async () => {
    // `locate` refuses a corpus with no selectable candidate - the exact Prettier failure.
    const record: any = {
      runId: "t", jobId: "immer-observation", shardIndex: 0, shardCount: 1,
      step: "preserving", timings: {}, errorClass: "no-candidates", error: "none were SELECTIVE",
      logs: { observe: "twenty five observations" },
    };
    const bucket = fakeBucket();
    const result = await stepOnce(record, getValidationJob("immer-observation"), fakeSandbox({ "/workspace/corpus.jsonl": '{"a":1}\n' }), bucket);

    assert.equal(result.record.step, "failed", "still ends failed - preservation never rescues a run");
    assert.equal(result.record.errorClass, "no-candidates", "the original cause is not overwritten");
    const keys = Object.keys(bucket.written);
    assert.ok(keys.some((k) => k.endsWith("/failed/corpus.jsonl")), `corpus preserved, got ${keys.join(", ")}`);
    assert.ok(keys.some((k) => k.endsWith("/failed/observe.log")), "harness output preserved");
    assert.ok(keys.some((k) => k.endsWith("/failed/failure.json")), "failure summary preserved");
  });

  it("terminates rather than looping when preservation itself cannot read anything", async () => {
    const record: any = {
      runId: "t", jobId: "immer-observation", shardIndex: 0, shardCount: 1,
      step: "preserving", timings: {}, errorClass: "boom", error: "boom",
    };
    const sandbox = {
      async readFile() { throw new Error("container is gone"); },
      async exec() { throw new Error("container is gone"); },
      async writeFile() {},
    };
    const result = await stepOnce(record, getValidationJob("immer-observation"), sandbox, fakeBucket());
    assert.equal(result.record.step, "failed");
    assert.equal(result.nextAlarmDelayMs, null, "no further alarm - a dead container must not spin");
  });
});
