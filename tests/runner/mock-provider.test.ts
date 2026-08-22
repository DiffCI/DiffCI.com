import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMockRunnerProvider } from "../../src/runner/mock-provider.js";

describe("MockRunnerProvider - Part 12", () => {
  it("provisionRunner returns a ready runner deterministically", async () => {
    const provider = createMockRunnerProvider();
    const instance = await provider.provisionRunner({ organizationId: "org_1", resourceClass: "standard-2" });
    assert.equal(instance.status, "ready");
    assert.ok(instance.providerRunnerId.startsWith("mock-"));
  });

  it("getRunnerStatus reflects the provisioned runner's state", async () => {
    const provider = createMockRunnerProvider();
    const instance = await provider.provisionRunner({ organizationId: "org_1", resourceClass: "standard-2" });
    const status = await provider.getRunnerStatus(instance.providerRunnerId);
    assert.equal(status.status, "ready");
  });

  it("getRunnerStatus for an unknown id reports terminated rather than throwing", async () => {
    const provider = createMockRunnerProvider();
    const status = await provider.getRunnerStatus("never-provisioned");
    assert.equal(status.status, "terminated");
  });

  it("terminateRunner is idempotent - calling it twice (or on an unknown id) never throws", async () => {
    const provider = createMockRunnerProvider();
    const instance = await provider.provisionRunner({ organizationId: "org_1", resourceClass: "standard-2" });
    await provider.terminateRunner(instance.providerRunnerId);
    await assert.doesNotReject(() => provider.terminateRunner(instance.providerRunnerId));
    await assert.doesNotReject(() => provider.terminateRunner("never-existed"));
    const status = await provider.getRunnerStatus(instance.providerRunnerId);
    assert.equal(status.status, "terminated");
  });
});
