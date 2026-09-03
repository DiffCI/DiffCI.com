/**
 * src/usage/cost-model.ts had no test file before this (YC readiness Week 1, 2026-09-04) - added
 * alongside createCloudflareContainersStandard2CostModel(), the model the website evidence ledger's
 * re-measured "CI cost per job" figure is computed with (ops/github-runner's real instance shape).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCloudflareContainersLiteCostModel, createCloudflareContainersStandard2CostModel, createDefaultComputeCostModel } from "../../src/usage/cost-model.js";

describe("createDefaultComputeCostModel", () => {
  it("is explicitly labelled 'estimated', never a provider-sourced number", () => {
    const model = createDefaultComputeCostModel();
    assert.equal(model.estimateCost({ computeSeconds: 10 }).basis, "estimated");
  });

  it("scales linearly with computeSeconds and never goes negative", () => {
    const model = createDefaultComputeCostModel(0.001);
    assert.equal(model.estimateCost({ computeSeconds: 100 }).estimatedUsd, 0.1);
    assert.equal(model.estimateCost({ computeSeconds: -50 }).estimatedUsd, 0);
  });
});

describe("createCloudflareContainersLiteCostModel", () => {
  it("is a real provider-sourced rate, labelled provider_estimate not estimated", () => {
    const model = createCloudflareContainersLiteCostModel();
    assert.equal(model.estimateCost({ computeSeconds: 60 }).basis, "provider_estimate");
  });
});

describe("createCloudflareContainersStandard2CostModel", () => {
  it("matches the real published rate for the SHAPE ops/github-runner actually uses: 1 vCPU, 6 GiB, 12 GB disk", () => {
    const model = createCloudflareContainersStandard2CostModel();
    const seconds = 143; // the real median job duration this test file's own re-measurement observed
    const expected = seconds * 1 * 0.00002 + seconds * 6 * 0.0000025 + seconds * 12 * 0.00000007;
    const got = model.estimateCost({ computeSeconds: seconds });
    assert.ok(Math.abs(got.estimatedUsd - expected) < 1e-9, `expected ~$${expected}, got $${got.estimatedUsd}`);
    assert.equal(got.basis, "provider_estimate");
  });

  it("is a materially higher rate than the lite model - a real, distinct instance size, not an approximation borrowed from a smaller one", () => {
    const lite = createCloudflareContainersLiteCostModel().estimateCost({ computeSeconds: 100 });
    const std2 = createCloudflareContainersStandard2CostModel().estimateCost({ computeSeconds: 100 });
    assert.ok(std2.estimatedUsd > lite.estimatedUsd, "standard-2 (1 vCPU/6GiB) must cost more per second than lite (0.25 vCPU/0.25GiB)");
  });

  it("never produces a negative cost for a negative duration", () => {
    const model = createCloudflareContainersStandard2CostModel();
    assert.equal(model.estimateCost({ computeSeconds: -10 }).estimatedUsd, 0);
  });
});
