import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getRepoExecutionProfile, listConfiguredRepositories } from "../../src/analysis-fanout/repo-execution-profiles.js";

describe("repo-execution-profiles", () => {
  it("returns undefined (never a guessed default) for an unconfigured repository", () => {
    assert.equal(getRepoExecutionProfile("vercel/turborepo"), undefined);
    assert.equal(getRepoExecutionProfile("not/configured"), undefined);
  });

  it("returns cal.com's real CI-derived profile verbatim", () => {
    const profile = getRepoExecutionProfile("calcom/cal.diy");
    assert.ok(profile);
    assert.equal(profile!.repository, "calcom/cal.diy");
    assert.equal(profile!.packageManager, "yarn");
    assert.deepEqual(profile!.installArgv, ["install"]);
    assert.deepEqual(profile!.pretestArgv, [["prisma", "generate"]]);
    assert.deepEqual(profile!.testArgv, ["test", "--", "--no-isolate"]);
    assert.deepEqual(profile!.testEnv, { TZ: "UTC" });
  });

  it("listConfiguredRepositories includes exactly the configured repositories", () => {
    const list = listConfiguredRepositories();
    assert.ok(list.includes("calcom/cal.diy"));
    assert.equal(list.length, new Set(list).size); // no duplicates
  });
});
