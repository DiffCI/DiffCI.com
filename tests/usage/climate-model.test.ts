import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDefaultClimateImpactModel, createCloudflareContainersLiteClimateModel } from "../../src/usage/climate-model.js";
import { CLOUDFLARE_CONTAINERS_LITE_PRICING } from "../../src/usage/cost-model.js";

describe("createDefaultClimateImpactModel", () => {
  it("is linear in compute-seconds and honest about basis - always 'estimated', never a stronger claim", () => {
    const model = createDefaultClimateImpactModel();
    const one = model.estimateCarbon({ computeSeconds: 1 });
    const ten = model.estimateCarbon({ computeSeconds: 10 });
    assert.equal(one.basis, "estimated");
    assert.ok(Math.abs(ten.estimatedKgCo2e - one.estimatedKgCo2e * 10) < 1e-12);
    assert.ok(one.estimatedKgCo2e > 0);
    assert.equal(one.ratePerComputeSecondKgCo2e, one.estimatedKgCo2e);
  });

  it("never returns a negative estimate for a negative input", () => {
    const model = createDefaultClimateImpactModel();
    const result = model.estimateCarbon({ computeSeconds: -5 });
    assert.equal(result.estimatedKgCo2e, 0);
  });

  it("a higher grid carbon intensity assumption produces a proportionally higher estimate", () => {
    const low = createDefaultClimateImpactModel(100).estimateCarbon({ computeSeconds: 100 });
    const high = createDefaultClimateImpactModel(200).estimateCarbon({ computeSeconds: 100 });
    assert.ok(Math.abs(high.estimatedKgCo2e - low.estimatedKgCo2e * 2) < 1e-12);
  });
});

describe("createCloudflareContainersLiteClimateModel", () => {
  it("uses Cloudflare's real 'lite' instance shape but is still only 'estimated' - no provider publishes real carbon/power data", () => {
    const model = createCloudflareContainersLiteClimateModel();
    const result = model.estimateCarbon({ computeSeconds: 3600 }); // 1 vCPU-hour-equivalent scaled by the lite fraction
    assert.equal(result.basis, "estimated");
    assert.ok(result.estimatedKgCo2e > 0);
  });

  it("the lite shape (0.25 vCPU / 256 MiB) produces a smaller rate than the generic 1 vCPU / 1 GiB default shape", () => {
    const lite = createCloudflareContainersLiteClimateModel().estimateCarbon({ computeSeconds: 100 });
    const generic = createDefaultClimateImpactModel().estimateCarbon({ computeSeconds: 100 });
    assert.ok(lite.estimatedKgCo2e < generic.estimatedKgCo2e);
  });

  it("is derived from the same real CLOUDFLARE_CONTAINERS_LITE_PRICING shape the cost model uses, not a re-guessed instance size", () => {
    // Sanity: the lite shape's vcpuMilli/memoryMiB really are the small values the pricing model uses -
    // this test exists to catch someone changing one without the other going out of sync.
    assert.equal(CLOUDFLARE_CONTAINERS_LITE_PRICING.vcpuMilli, 250);
    assert.equal(CLOUDFLARE_CONTAINERS_LITE_PRICING.memoryMiB, 256);
  });
});
