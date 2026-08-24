import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  collectRowFileName,
  collectRunRecordFileName,
  resolveCollectWrite,
} from "../../src/analysis-fanout/collect-names.js";

describe("collect filename decisions", () => {
  it("a non-retry collect writes the baseline row file name", () => {
    assert.equal(
      collectRowFileName("turborepo", "", ""),
      "2026-08-23-turborepo-blind-baseline-rows.jsonl",
    );
  });

  it("a retry writes a distinctly-named file", () => {
    assert.equal(
      collectRowFileName("turborepo", "retry-1", "oom"),
      "2026-08-23-turborepo-blind-baseline-rows-retry-oom.jsonl",
    );
  });

  it("a retry without a reason uses 'unknown'", () => {
    assert.equal(
      collectRowFileName("turborepo", "retry-1", ""),
      "2026-08-23-turborepo-blind-baseline-rows-retry-unknown.jsonl",
    );
  });

  it("the run-record file name embeds the runId", () => {
    assert.equal(
      collectRunRecordFileName("blind-2026-08-23"),
      "2026-08-23-blind-2026-08-23-fanout-run-record.json",
    );
  });

  it("resolveCollectWrite refuses (exists=true) when the file already exists", () => {
    const decision = resolveCollectWrite(
      "/out",
      "turborepo",
      "",
      "",
      (p) => p.endsWith("2026-08-23-turborepo-blind-baseline-rows.jsonl"),
    );
    assert.equal(decision.exists, true);
  });

  it("resolveCollectWrite allows a non-existing path, and a retry produces a different name", () => {
    const plain = resolveCollectWrite("/out", "turborepo", "", "", () => false);
    assert.equal(plain.exists, false);
    assert.ok(plain.path.endsWith("2026-08-23-turborepo-blind-baseline-rows.jsonl"));

    const retry = resolveCollectWrite("/out", "turborepo", "retry-1", "oom", () => false);
    assert.equal(retry.exists, false);
    assert.ok(retry.path.endsWith("2026-08-23-turborepo-blind-baseline-rows-retry-oom.jsonl"));
    assert.notEqual(retry.path, plain.path);
  });

  it("a completed baseline file is never the target of a retry write", () => {
    // Simulate the baseline file existing but the retry file not: the decision must still be a fresh path.
    const decision = resolveCollectWrite(
      "/out",
      "turborepo",
      "retry-2",
      "oom",
      (p) => p.endsWith("2026-08-23-turborepo-blind-baseline-rows.jsonl"),
    );
    assert.equal(decision.exists, false);
    assert.ok(decision.path.endsWith("2026-08-23-turborepo-blind-baseline-rows-retry-oom.jsonl"));
  });
});