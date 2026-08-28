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
  PINNED_CLONE,
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

  it("points the observation pass at the pinned clone, never at the live repository", () => {
    const corpus = buildJobCorpus(job) as Array<{ source: string; commits: number }>;
    assert.equal(corpus.length, 1);
    assert.equal(corpus[0]!.source, PINNED_CLONE);
    assert.equal(corpus[0]!.commits, job.commits);
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
