import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { recordDecision, summarizeSafetyBudget, type SafetyBudget } from "../../src/analysis-fanout/safety-budget.js";

const IDENTITY = { repository: "deepseek-ai/deepseek-harness", branch: "main", environmentIdentity: "nonroot", testFamily: "unit", commandIdentity: "test" };

function outcome(overrides: Partial<Parameters<typeof recordDecision>[2]> = {}) {
  return {
    audited: false,
    outcomeChangingMiss: false,
    selectedWallMs: 20_000,
    fullWallMs: undefined,
    stage: "test",
    observedAtMs: 1000,
    ...overrides,
  };
}

describe("recordDecision", () => {
  it("starts a fresh budget from undefined and records one decision", () => {
    const b = recordDecision(undefined, IDENTITY, outcome());
    assert.equal(b.totalDecisions, 1);
    assert.equal(b.auditedDecisions, 0);
    assert.equal(b.cumulativeSelectedWallMs, 20_000);
  });

  it("a non-audited decision contributes to totals/selected time but NEVER to audited/miss counts or audited full-time", () => {
    const b = recordDecision(undefined, IDENTITY, outcome({ audited: false, outcomeChangingMiss: true /* ignored - not audited */, fullWallMs: 999_999 /* ignored - not audited */ }));
    assert.equal(b.totalDecisions, 1);
    assert.equal(b.auditedDecisions, 0);
    assert.equal(b.outcomeChangingMisses, 0);
    assert.equal(b.cumulativeAuditedFullWallMs, 0);
  });

  it("an audited decision with no miss increments auditedDecisions and cumulativeAuditedFullWallMs but not outcomeChangingMisses", () => {
    const b = recordDecision(undefined, IDENTITY, outcome({ audited: true, outcomeChangingMiss: false, fullWallMs: 500_000 }));
    assert.equal(b.auditedDecisions, 1);
    assert.equal(b.outcomeChangingMisses, 0);
    assert.equal(b.cumulativeAuditedFullWallMs, 500_000);
  });

  it("an audited decision WITH a miss increments outcomeChangingMisses", () => {
    const b = recordDecision(undefined, IDENTITY, outcome({ audited: true, outcomeChangingMiss: true, fullWallMs: 500_000 }));
    assert.equal(b.outcomeChangingMisses, 1);
  });

  it("accumulates across multiple decisions - read-merge-write, not overwrite", () => {
    let b: SafetyBudget | undefined;
    b = recordDecision(b, IDENTITY, outcome({ audited: true, outcomeChangingMiss: false, fullWallMs: 500_000, selectedWallMs: 20_000, observedAtMs: 1000 }));
    b = recordDecision(b, IDENTITY, outcome({ audited: false, selectedWallMs: 21_000, observedAtMs: 2000 }));
    b = recordDecision(b, IDENTITY, outcome({ audited: true, outcomeChangingMiss: true, fullWallMs: 480_000, selectedWallMs: 19_000, observedAtMs: 3000 }));
    assert.equal(b.totalDecisions, 3);
    assert.equal(b.auditedDecisions, 2);
    assert.equal(b.outcomeChangingMisses, 1);
    assert.equal(b.cumulativeSelectedWallMs, 20_000 + 21_000 + 19_000);
    assert.equal(b.cumulativeAuditedFullWallMs, 500_000 + 480_000);
    assert.equal(b.updatedAtMs, 3000);
  });

  it("byStage breaks down the SAME totals per stage, and the top-level fields sum across stages", () => {
    let b: SafetyBudget | undefined;
    b = recordDecision(b, IDENTITY, outcome({ stage: "test", audited: true, fullWallMs: 100_000, selectedWallMs: 5_000 }));
    b = recordDecision(b, IDENTITY, outcome({ stage: "build", audited: true, fullWallMs: 200_000, selectedWallMs: 50_000 }));
    assert.equal(b.byStage.test!.auditedDecisions, 1);
    assert.equal(b.byStage.build!.auditedDecisions, 1);
    assert.equal(b.byStage.test!.cumulativeAuditedFullWallMs, 100_000);
    assert.equal(b.byStage.build!.cumulativeAuditedFullWallMs, 200_000);
    assert.equal(b.auditedDecisions, 2); // top-level sums across stages
    assert.equal(b.cumulativeAuditedFullWallMs, 300_000);
  });
});

describe("summarizeSafetyBudget", () => {
  it("INSUFFICIENT_AUDITED_SAMPLE below the minimum, regardless of how clean the small sample looks - no miss-rate percentage is ever computed", () => {
    let b: SafetyBudget | undefined;
    for (let i = 0; i < 2; i++) b = recordDecision(b, IDENTITY, outcome({ audited: true, outcomeChangingMiss: false, fullWallMs: 500_000, observedAtMs: i * 1000 }));
    const s = summarizeSafetyBudget(b!, 10);
    assert.equal(s.confidence, "INSUFFICIENT_AUDITED_SAMPLE");
    assert.equal(s.observedMissRatePct, undefined);
  });

  it("TRACK_RECORD_ESTABLISHED at or above the minimum sample size, with a real computed miss-rate", () => {
    let b: SafetyBudget | undefined;
    for (let i = 0; i < 10; i++) b = recordDecision(b, IDENTITY, outcome({ audited: true, outcomeChangingMiss: false, fullWallMs: 500_000, observedAtMs: i * 1000 }));
    const s = summarizeSafetyBudget(b!, 10);
    assert.equal(s.confidence, "TRACK_RECORD_ESTABLISHED");
    assert.equal(s.observedMissRatePct, 0);
  });

  it("the real user-quoted shape: 247 audited decisions, 0 misses -> TRACK_RECORD_ESTABLISHED, 0% miss rate", () => {
    let b: SafetyBudget | undefined;
    for (let i = 0; i < 247; i++) b = recordDecision(b, IDENTITY, outcome({ audited: true, outcomeChangingMiss: false, fullWallMs: 500_000, selectedWallMs: 2_000, observedAtMs: i * 1000 }));
    const s = summarizeSafetyBudget(b!, 10);
    assert.equal(s.confidence, "TRACK_RECORD_ESTABLISHED");
    assert.equal(s.auditedDecisions, 247);
    assert.equal(s.observedMissRatePct, 0);
    assert.equal(Math.round((s.observedWorkloadReductionPct ?? 0) * 10) / 10, 99.6); // (500000-2000)/500000*100 = 99.6
  });

  it("a nonzero miss rate is computed honestly once sample size is sufficient", () => {
    let b: SafetyBudget | undefined;
    for (let i = 0; i < 20; i++) b = recordDecision(b, IDENTITY, outcome({ audited: true, outcomeChangingMiss: i < 2 /* 2 misses out of 20 */, fullWallMs: 500_000, observedAtMs: i * 1000 }));
    const s = summarizeSafetyBudget(b!, 10);
    assert.equal(s.observedMissRatePct, 10); // 2/20 * 100
  });

  it("observedWorkloadReductionPct is undefined when no audited decision has any measured full-suite time yet", () => {
    let b: SafetyBudget | undefined;
    for (let i = 0; i < 5; i++) b = recordDecision(b, IDENTITY, outcome({ audited: false, selectedWallMs: 1000, observedAtMs: i * 1000 }));
    const s = summarizeSafetyBudget(b!, 1);
    assert.equal(s.observedWorkloadReductionPct, undefined);
  });

  it("observedWorkloadReductionPct is reported even while INSUFFICIENT_AUDITED_SAMPLE for the miss-rate - it's a measurement, not a statistical claim, so it doesn't need the same sample-size guard", () => {
    let b: SafetyBudget | undefined;
    b = recordDecision(b, IDENTITY, outcome({ audited: true, outcomeChangingMiss: false, fullWallMs: 100_000, selectedWallMs: 10_000, observedAtMs: 1000 }));
    const s = summarizeSafetyBudget(b!, 50); // far above the 1-sample budget
    assert.equal(s.confidence, "INSUFFICIENT_AUDITED_SAMPLE");
    assert.equal(s.observedWorkloadReductionPct, 90);
  });
});
