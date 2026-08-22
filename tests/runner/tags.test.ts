import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildRunnerResourceTags } from "../../src/runner/tags.js";

describe("buildRunnerResourceTags - Part 24", () => {
  it("includes project/environment/runnerId/organizationId at minimum", () => {
    const tags = buildRunnerResourceTags({ environment: "production", runnerId: "r1", organizationId: "org_uuid_1" });
    assert.equal(tags.project, "diffci");
    assert.equal(tags.environment, "production");
    assert.equal(tags.runnerId, "r1");
    assert.equal(tags.organizationId, "org_uuid_1");
    assert.ok(tags.createdAt);
  });

  it("never contains an owner/name-style repository string - repositoryId is DiffCI's own internal id", () => {
    const tags = buildRunnerResourceTags({ environment: "production", runnerId: "r1", organizationId: "org_1", repositoryId: "repo_uuid_1" });
    assert.equal(tags.repositoryId, "repo_uuid_1");
    assert.doesNotMatch(tags.repositoryId!, /\//, "repositoryId must be an internal id, never an 'owner/name' string");
  });
});
