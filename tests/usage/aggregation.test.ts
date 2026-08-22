import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeAllowanceStatus, endOfUtcMonth, startOfUtcMonth } from "../../src/usage/aggregation.js";
import { getPlanEntitlements } from "../../src/billing/plans.js";

describe("startOfUtcMonth / endOfUtcMonth", () => {
  it("computes correct UTC month boundaries", () => {
    const d = new Date("2026-08-22T04:41:34Z");
    assert.equal(startOfUtcMonth(d).toISOString(), "2026-08-01T00:00:00.000Z");
    assert.equal(endOfUtcMonth(d).toISOString(), "2026-09-01T00:00:00.000Z");
  });
});

describe("computeAllowanceStatus - Part 7", () => {
  it("bounded plan reports correct remaining/percent", () => {
    const status = computeAllowanceStatus(getPlanEntitlements("free"), 150);
    assert.equal(status.planAllowance, 200);
    assert.equal(status.remaining, 50);
    assert.equal(status.percentConsumed, 75);
  });

  it("caps percentConsumed at 100 even if usage exceeds allowance", () => {
    const status = computeAllowanceStatus(getPlanEntitlements("free"), 999);
    assert.equal(status.remaining, 0);
    assert.equal(status.percentConsumed, 100);
  });

  it("unlimited plans report Infinity remaining and 0 percent consumed", () => {
    const status = computeAllowanceStatus(getPlanEntitlements("business"), 999_999);
    assert.equal(status.planAllowance, -1);
    assert.equal(status.remaining, Infinity);
    assert.equal(status.percentConsumed, 0);
  });
});
