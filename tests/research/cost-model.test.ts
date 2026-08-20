import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BUDGET_CREDIT_CEILING,
  BUDGET_HARD_STOP_THRESHOLD,
  BUDGET_RESERVE_THRESHOLD,
  BUDGET_WARNING_THRESHOLD,
  computeMeasuredUsd,
  computeSpend,
  evaluateBudgetStatus,
  isSafeToStartUnderReserve,
  projectRemainingSpendUsd,
  usdToCredits,
  zeroUsageCounters,
} from "../../src/research/config/cost-model.js";

describe("cost model - budget tiers", () => {
  it("reports OK below the warning threshold", () => {
    const result = evaluateBudgetStatus(BUDGET_WARNING_THRESHOLD - 1);
    assert.equal(result.status, "OK");
    assert.equal(result.mustStop, false);
    assert.equal(result.reserveMode, false);
  });

  it("reports WARNING at the 1,600-credit boundary", () => {
    const result = evaluateBudgetStatus(BUDGET_WARNING_THRESHOLD);
    assert.equal(result.status, "WARNING");
    assert.equal(result.mustStop, false);
    assert.equal(result.reserveMode, false);
  });

  it("reports RESERVE at the 1,850-credit boundary", () => {
    const result = evaluateBudgetStatus(BUDGET_RESERVE_THRESHOLD);
    assert.equal(result.status, "RESERVE");
    assert.equal(result.mustStop, false);
    assert.equal(result.reserveMode, true);
  });

  it("reports BUDGET_STOPPED at the 1,950-credit hard-stop boundary", () => {
    const result = evaluateBudgetStatus(BUDGET_HARD_STOP_THRESHOLD);
    assert.equal(result.status, "BUDGET_STOPPED");
    assert.equal(result.mustStop, true);
    assert.equal(result.reserveMode, true);
  });

  it("never lets remainingCredits go negative past the ceiling", () => {
    const result = evaluateBudgetStatus(BUDGET_CREDIT_CEILING + 500);
    assert.equal(result.status, "BUDGET_STOPPED");
    assert.equal(result.remainingCredits, 0);
  });

  it("reserves roughly the last 50 credits for bookkeeping (ceiling - hard stop)", () => {
    assert.equal(BUDGET_CREDIT_CEILING - BUDGET_HARD_STOP_THRESHOLD, 50);
  });
});

describe("cost model - measured vs estimated spend", () => {
  it("computes measured spend from exact operation counts x published rates only", () => {
    const counters = { ...zeroUsageCounters(), r2ClassAOps: 1_000_000, d1RowsWritten: 1_000_000 };
    const measured = computeMeasuredUsd(counters);
    // 1M R2 Class A ops ($4.50/M) + 1M D1 rows written ($1.00/M) = $5.50, independent of any CPU-ms.
    assert.ok(Math.abs(measured - 5.5) < 1e-9, `expected ~$5.50, got $${measured}`);
  });

  it("computes measured spend from real Container active-CPU/memory/disk usage (2026-08-21, the actual execution path)", () => {
    // Added when the full-experiment orchestrator revealed the original cost model had no Container
    // pricing dimension at all - the real execution path runs inside Cloudflare Containers, not
    // Workflows, which the original 2026-08-20 design assumed.
    const counters = { ...zeroUsageCounters(), containerVcpuSeconds: 1000, containerMemoryGibSeconds: 500, containerDiskGbSeconds: 2000 };
    const measured = computeMeasuredUsd(counters);
    // 1000 vCPU-s x $0.00002 + 500 GiB-s x $0.0000025 + 2000 GB-s x $0.00000007
    const expected = 1000 * 0.00002 + 500 * 0.0000025 + 2000 * 0.00000007;
    assert.ok(Math.abs(measured - expected) < 1e-9, `expected ~$${expected}, got $${measured}`);
  });

  it("computes estimated spend from CPU-ms separately and never merges it into measured", () => {
    const counters = zeroUsageCounters();
    const spend = computeSpend(counters, 1_000_000);
    assert.equal(spend.measuredUsd, 0);
    // 1,000,000 CPU-ms x $0.02/1,000,000 = $0.02
    assert.ok(Math.abs(spend.estimatedUsd - 0.02) < 1e-9);
    assert.ok(Math.abs(spend.totalUsd - (spend.measuredUsd + spend.estimatedUsd)) < 1e-12);
  });

  it("1 credit equals $1 (the approved conversion, not an invented one)", () => {
    assert.equal(usdToCredits(42.5), 42.5);
  });
});

describe("cost model - reserve-mode safety projection", () => {
  it("blocks starting new work when the projected cost would cross the hard stop", () => {
    const safe = isSafeToStartUnderReserve(BUDGET_RESERVE_THRESHOLD, 200);
    assert.equal(safe, false, "1,850 + 200*1.2 margin = 2,090, well past the 1,950 hard stop");
  });

  it("allows starting new work when the projected cost safely fits", () => {
    const safe = isSafeToStartUnderReserve(BUDGET_RESERVE_THRESHOLD, 10);
    assert.equal(safe, true, "1,850 + 10*1.2 margin = 1,862, under the 1,950 hard stop");
  });

  it("projects remaining spend from average-per-unit cost so far", () => {
    const projected = projectRemainingSpendUsd(100, 10, 5);
    assert.equal(projected, 50, "avg $10/unit x 5 remaining units = $50");
  });

  it("projects zero when nothing has completed yet (avoids divide-by-zero)", () => {
    assert.equal(projectRemainingSpendUsd(0, 0, 100), 0);
  });
});
