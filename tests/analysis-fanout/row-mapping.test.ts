import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  exitFailureRow,
  hasVerdict,
  isResourceKill,
  mapExecFailureToRow,
  resourceKillRow,
  timeoutRow,
} from "../../src/analysis-fanout/row-mapping.js";
import type { ContainerMetrics } from "../../src/analysis-fanout/row-mapping.js";
import type { MergeRow } from "../../src/analysis-fanout/fanout-types.js";

function makeMerge(): MergeRow {
  return {
    index: 1,
    prNumber: 1,
    mergeSha: "b".repeat(40),
    baseSha: "a".repeat(40),
    mergeTimestamp: "2026-08-23T00:00:00Z",
    subject: "merge 1",
    changedFiles: 1,
  };
}

const metrics: ContainerMetrics = {
  shape: "standard-2",
  memAvailableBeforeMb: 6000,
  memAvailableAfterMb: 4000,
  peakRssMb: 500,
};

describe("isResourceKill", () => {
  it("is true only for exit 137", () => {
    assert.equal(isResourceKill(137), true);
    assert.equal(isResourceKill(0), false);
    assert.equal(isResourceKill(1), false);
    assert.equal(isResourceKill(128), false);
    assert.equal(isResourceKill(143), false);
    assert.equal(isResourceKill(null), false);
    assert.equal(isResourceKill(undefined), false);
  });
});

describe("failure rows never carry a DiffCI verdict", () => {
  it("resourceKillRow has errorClass resource-kill and no verdict", () => {
    const row = resourceKillRow(makeMerge(), "x/y", metrics);
    assert.equal(row.ok, false);
    assert.equal(row.errorClass, "resource-kill");
    assert.equal(row.exitCode, 137);
    assert.equal(hasVerdict(row), false);
  });

  it("timeoutRow has errorClass timeout and no verdict", () => {
    const row = timeoutRow(makeMerge(), "x/y", "per-step timeout exceeded");
    assert.equal(row.ok, false);
    assert.equal(row.errorClass, "timeout");
    assert.equal(hasVerdict(row), false);
  });

  it("exitFailureRow distinguishes signal vs plain exit, with no verdict", () => {
    const signal = exitFailureRow(makeMerge(), "x/y", { success: false, exitCode: 0, signal: "SIGTERM" });
    assert.equal(signal.errorClass, "signal:SIGTERM");
    assert.equal(hasVerdict(signal), false);

    const exit = exitFailureRow(makeMerge(), "x/y", { success: false, exitCode: 2 });
    assert.equal(exit.errorClass, "exit:2");
    assert.equal(hasVerdict(exit), false);
  });
});

describe("mapExecFailureToRow errorClass selection", () => {
  it("a timed-out exec maps to timeout (even alongside 137)", () => {
    const row = mapExecFailureToRow(makeMerge(), "x/y", { success: false, exitCode: 137, timedOut: true }, metrics);
    assert.equal(row.errorClass, "timeout");
    assert.equal(hasVerdict(row), false);
  });

  it("exit 137 maps to resource-kill", () => {
    const row = mapExecFailureToRow(makeMerge(), "x/y", { success: false, exitCode: 137 }, metrics);
    assert.equal(row.errorClass, "resource-kill");
    assert.equal(hasVerdict(row), false);
  });

  it("a signal maps to signal:<name>", () => {
    const row = mapExecFailureToRow(makeMerge(), "x/y", { success: false, exitCode: 0, signal: "SIGKILL" }, metrics);
    assert.equal(row.errorClass, "signal:SIGKILL");
    assert.equal(hasVerdict(row), false);
  });

  it("a plain non-zero exit maps to exit:<code>", () => {
    const row = mapExecFailureToRow(makeMerge(), "x/y", { success: false, exitCode: 1 }, metrics);
    assert.equal(row.errorClass, "exit:1");
    assert.equal(hasVerdict(row), false);
  });
});