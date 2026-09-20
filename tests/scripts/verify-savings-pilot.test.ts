import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { buildReport, parseArgs, renderMarkdown, runPilot, type CommandMeasurement } from "../../scripts/verify-savings-pilot.js";

const measurement = (command: string, exitCode: number, wallMs: number): CommandMeasurement => ({
  command,
  exitCode,
  signal: null,
  timedOut: false,
  startedAt: "2026-09-20T00:00:00.000Z",
  finishedAt: "2026-09-20T00:00:01.000Z",
  wallMs,
  stdoutTail: "",
  stderrTail: "",
});

describe("verify-savings pilot report", () => {
  it("charges analysis overhead to the selected arm", () => {
    const report = buildReport({
      producedAt: "2026-09-20T00:00:00.000Z",
      cwd: "/repo",
      timeoutMs: 60_000,
      analysisOverheadMs: 250,
      selection: { source: "manual" },
      full: measurement("npm test", 0, 1000),
      selected: measurement("npm test a.test.ts", 0, 400),
    });

    assert.equal(report.comparison.netSelectedMs, 650);
    assert.equal(report.comparison.deltaMs, 350);
    assert.equal(report.comparison.percentChange, 35);
    assert.equal(report.comparison.fullCommandSucceeded, true);
    assert.equal(report.comparison.selectedCommandSucceeded, true);
  });

  it("flags the safety case that needs manual inspection", () => {
    const report = buildReport({
      producedAt: "2026-09-20T00:00:00.000Z",
      cwd: "/repo",
      timeoutMs: 60_000,
      selection: { source: "manual" },
      full: measurement("npm test", 1, 1000),
      selected: measurement("npm test a.test.ts", 0, 200),
    });

    assert.equal(report.comparison.missedFailureSignal, true);
    assert.ok(report.notes.some((note) => note.includes("Full failed while selected passed")));
  });

  it("renders measured language without claiming production savings", () => {
    const report = buildReport({
      producedAt: "2026-09-20T00:00:00.000Z",
      label: "friendly/repo",
      cwd: "/repo",
      timeoutMs: 60_000,
      selection: { source: "diffci-observation", observationReportPath: "/tmp/diffci.json", selectedTestCount: 1, totalTestCount: 10 },
      full: measurement("npm test", 0, 1000),
      selected: measurement("npm test a.test.ts", 0, 200),
    });

    const markdown = renderMarkdown(report);
    assert.match(markdown, /measured pilot evidence/);
    assert.match(markdown, /not a production-savings claim/);
    assert.match(markdown, /friendly\/repo/);
    assert.match(markdown, /Selected tests: 1 of 10/);
    assert.match(markdown, /No analysis overhead was provided/);
  });

  it("puts a loud warning in markdown when selected passes but full fails", () => {
    const report = buildReport({
      producedAt: "2026-09-20T00:00:00.000Z",
      cwd: "/repo",
      timeoutMs: 60_000,
      selection: { source: "manual" },
      full: measurement("npm test", 1, 1000),
      selected: measurement("npm test a.test.ts", 0, 200),
    });

    assert.match(renderMarkdown(report), /WARNING: Full failed while selected passed/);
  });

  it("requires the two commands and output path", () => {
    assert.throws(() => parseArgs(["--selected", "npm test a.test.ts", "--out", "report.json"]), /--full/);
    assert.throws(() => parseArgs(["--full", "npm test", "--out", "report.json"]), /--selected/);
    assert.throws(() => parseArgs(["--full", "npm test", "--selected", "npm test a.test.ts"]), /--out/);
    assert.throws(
      () => parseArgs(["--full", "npm test", "--selected", "npm test a.test.ts", "--selected-from-report", "diffci.json", "--out", "report.json"]),
      /only one/,
    );
  });

  it("can use a DiffCI observation report as the selected command source", () => {
    const dir = mkdtempSync(join(tmpdir(), "diffci-pilot-"));
    const observation = join(dir, "observation.json");
    writeFileSync(
      observation,
      JSON.stringify({
        schema: "diffci.observation.v1",
        status: "OBSERVED",
        timings: { totalMs: 7 },
        result: {
          proposedCommands: ["node --version"],
          selectedTests: ["src/a.test.ts"],
          totalTestCount: 3,
        },
      }),
      "utf8",
    );

    const report = runPilot(
      parseArgs([
        "--label",
        "owner/repo",
        "--full",
        "node --version",
        "--selected-from-report",
        observation,
        "--out",
        join(dir, "report.json"),
      ]),
    );

    assert.equal(report.label, "owner/repo");
    assert.equal(report.selectionSource, "diffci-observation");
    assert.equal(report.analysisOverheadMs, 7);
    assert.equal(report.selectedTestCount, 1);
    assert.equal(report.totalTestCount, 3);
    assert.equal(report.full.exitCode, 0);
    assert.equal(report.selected.exitCode, 0);
  });
});
