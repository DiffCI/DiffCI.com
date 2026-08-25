import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getRepoExecutionProfile, listConfiguredRepositories } from "../../src/analysis-fanout/repo-execution-profiles.js";

describe("repo-execution-profiles", () => {
  it("returns undefined (never a guessed default) for an unconfigured repository", () => {
    assert.equal(getRepoExecutionProfile("vercel/turborepo"), undefined);
    assert.equal(getRepoExecutionProfile("not/configured"), undefined);
  });

  it("returns cal.com's real CI-derived profile verbatim, WITHOUT the -- the CI workflow line shows", () => {
    const profile = getRepoExecutionProfile("calcom/cal.diy");
    assert.ok(profile);
    assert.equal(profile!.repository, "calcom/cal.diy");
    assert.equal(profile!.packageManager, "yarn");
    assert.deepEqual(profile!.installArgv, ["install"]);
    assert.deepEqual(profile!.pretestArgv, [["prisma", "generate"]]);
    // Deliberately no "--" (2026-08-24 finding): this repo's yarn/vitest combination silently drops
    // everything after a literal "--" in "yarn test -- <args>" - confirmed via a live Cloudflare
    // diagnostic probe (docs/research/2026-08-24-calcom-execution-observability/07-argument-forwarding-
    // root-cause.md). "yarn test --no-isolate <file>" forwards correctly; "yarn test -- --no-isolate
    // <file>" silently runs the full suite with none of it applied.
    assert.deepEqual(profile!.testArgv, ["test", "--no-isolate"]);
    assert.deepEqual(profile!.testEnv, { TZ: "UTC" });
    // 2026-08-24 max-step-duration safeguard: tighter than the harness's own 20-min global default,
    // since every normal observation of this command finishes in well under 4 minutes.
    assert.equal(profile!.maxTestRunMs, 10 * 60_000);
  });

  it("returns deepseek-harness's unit-family profile verbatim (2026-08-25 DeepSeek execution-validation mission)", () => {
    const profile = getRepoExecutionProfile("deepseek-ai/deepseek-harness");
    assert.ok(profile);
    assert.equal(profile!.repository, "deepseek-ai/deepseek-harness");
    assert.equal(profile!.packageManager, "pnpm");
    // --ignore-scripts is a deliberate sandbox-safety policy, not a CI-fidelity deviation (see the
    // profile's own doc comment) - real CI runs a bare `pnpm install --frozen-lockfile`.
    assert.deepEqual(profile!.installArgv, ["install", "--frozen-lockfile", "--ignore-scripts"]);
    assert.deepEqual(profile!.pretestArgv, []);
    // "test" -> package.json's "test": "vitest run" (plain, uninstrumented) - deliberately NOT the real
    // CI unit gate's coverage-partitioned wrapper (no simple per-file selective shape); see the profile's
    // doc comment and docs/research/2026-08-25-deepseek-execution-validation/01-....md.
    assert.deepEqual(profile!.testArgv, ["test"]);
    assert.deepEqual(profile!.reporterArgv, ["--reporter=json", "--reporter=default"]);
    assert.equal(profile!.maxTestRunMs, 15 * 60_000);
  });

  it("listConfiguredRepositories includes exactly the configured repositories", () => {
    const list = listConfiguredRepositories();
    assert.ok(list.includes("calcom/cal.diy"));
    assert.ok(list.includes("deepseek-ai/deepseek-harness"));
    assert.equal(list.length, new Set(list).size); // no duplicates
  });
});
