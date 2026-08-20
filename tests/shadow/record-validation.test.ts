import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { validateShadowRunRecord } from "../../src/shadow/record-validation.js";
import type { ShadowRunRecord, ShadowRunIdentity } from "../../src/shadow/types.js";
import type { ExecutionPlan } from "../../src/planner/types.js";

function makeIdentity(overrides: Partial<ShadowRunIdentity> = {}): ShadowRunIdentity {
  const baseSha = overrides.baseSha ?? "base";
  const headSha = overrides.headSha ?? "head";
  const schemaVersion = overrides.schemaVersion ?? "diffci-shadow/1";
  const diffciVersion = overrides.diffciVersion ?? "0.6.0";
  return {
    repository: "owner/repo",
    baseSha,
    headSha,
    diffciVersion,
    schemaVersion,
    logicalKey: `${baseSha}:${headSha}:${schemaVersion}:${diffciVersion}`,
    executionKey: "1.1",
    ...overrides,
  };
}

function makePlan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    version: "6.0.0",
    mode: "SELECTIVE",
    tasks: [],
    selectedTests: [],
    skippedTests: [],
    alwaysRunTasks: [],
    fallbackReasons: [],
    evidence: [],
    safety: { graphConfidence: "COMPLETE", impactStatus: "SAFE_TO_PROPOSE", fallbackRequired: false },
    commandSpecs: [],
    ...overrides,
  };
}

function makeRecord(overrides: Partial<ShadowRunRecord> = {}): ShadowRunRecord {
  const identity = makeIdentity();
  return {
    schemaVersion: identity.schemaVersion,
    recordedAt: new Date().toISOString(),
    runIdentity: identity,
    commit: { baseSha: identity.baseSha, headSha: identity.headSha },
    changedFiles: [],
    impactFallback: false,
    fallbackReasons: [],
    plan: makePlan(),
    actualTasks: [],
    proposedTasks: [],
    actualTestCount: 0,
    selectedTestCount: 0,
    timing: {
      gitAnalysisMs: 1,
      graphConstructionMs: 2,
      impactAnalysisMs: 3,
      plannerMs: 4,
      totalDiffCiOverheadMs: 10,
    },
    ...overrides,
  };
}

describe("ShadowRunRecord validation", () => {
  it("accepts a valid record", () => {
    const v = validateShadowRunRecord(makeRecord());
    assert.strictEqual(v.valid, true);
    assert.deepStrictEqual(v.errors, []);
  });

  it("rejects a record with inconsistent logical key", () => {
    const record = makeRecord({
      runIdentity: makeIdentity({ logicalKey: "tampered" }),
    });
    const v = validateShadowRunRecord(record);
    assert.strictEqual(v.valid, false);
    assert.ok(v.errors.some((e) => e.includes("logicalKey inconsistent")));
  });

  it("rejects a record with plan mode inconsistent with fallback", () => {
    const record = makeRecord({
      plan: makePlan({ mode: "SELECTIVE", safety: { graphConfidence: "COMPLETE", impactStatus: "FALLBACK", fallbackRequired: true } }),
      impactFallback: true,
    });
    const v = validateShadowRunRecord(record);
    assert.strictEqual(v.valid, false);
    assert.ok(v.errors.some((e) => e.includes("plan mode is inconsistent")));
  });

  it("rejects negative timings", () => {
    const record = makeRecord({
      timing: { gitAnalysisMs: -1, graphConstructionMs: 0, impactAnalysisMs: 0, plannerMs: 0, totalDiffCiOverheadMs: 0 },
    });
    const v = validateShadowRunRecord(record);
    assert.strictEqual(v.valid, false);
    assert.ok(v.errors.some((e) => e.includes("timing.gitAnalysisMs")));
  });

  it("rejects records containing secrets", () => {
    const record = makeRecord({
      fallbackReasons: ["something ghs_12345 leaked"],
    });
    const v = validateShadowRunRecord(record);
    assert.strictEqual(v.valid, false);
    assert.ok(v.errors.some((e) => e.includes("sensitive value")));
  });
});
