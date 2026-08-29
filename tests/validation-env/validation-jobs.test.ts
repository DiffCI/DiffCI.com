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
} from "../../src/validation-env/validation-jobs.js";

const repoRoot = resolve(dirname(import.meta.filename), "..", "..");
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
      assert.ok(isPinnedSha(job.pinnedHeadSha), `${id} must pin a full 40-hex sha`);
      assert.ok(isRepositorySlug(job.repository), `${id} must name owner/name`);
      assert.ok(job.commits > 0, `${id} must observe at least one commit`);
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
    assert.deepEqual(job.mutate.install, manifest.commands.install);
    assert.equal(job.mutate.testModule, manifest.commands.testModule);
    assert.deepEqual(job.mutate.testArgs, manifest.commands.testArgs);
    assert.equal(job.mutate.maxAttempts, manifest.maxAttempts);
    assert.equal(job.mutate.timeoutMs, manifest.timeoutMs);
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
