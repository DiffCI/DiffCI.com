import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { buildReport, parseArgs, renderMarkdown, runPilot, type CommandMeasurement } from "../../scripts/verify-savings-pilot.js";
import { formatVerifySavingsSummary } from "../../src/client/verify-savings.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

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
  it("rejects incomplete or ambiguous plans before executing either arm", () => {
    const dir = mkdtempSync(join(tmpdir(), "diffci-pilot-plan-"));
    const observation = join(dir, "observation.json");
    const marker = join(dir, "executed.txt");
    writeFileSync(join(dir, "marker.cjs"), "require('node:fs').writeFileSync('executed.txt', 'ran')");
    for (const proposedCommands of [[], [""], ["   "], [12], ["node --version", "node --version"]]) {
      writeFileSync(observation, JSON.stringify({ status: "OBSERVED", result: { proposedCommands } }));
      assert.throws(() => runPilot(parseArgs([
        "--full", "node marker.cjs", "--cwd", dir,
        "--selected-from-report", observation, "--out", join(dir, "report.json"),
      ])), /exactly one non-empty proposed command/);
      assert.equal(existsSync(marker), false);
    }
  });

  it("exits non-zero when the CLI rejects an ambiguous report", () => {
    const dir = mkdtempSync(join(tmpdir(), "diffci-cli-plan-"));
    const observation = join(dir, "observation.json");
    const marker = join(dir, "executed.txt");
    writeFileSync(join(dir, "marker.cjs"), "require('node:fs').writeFileSync('executed.txt', 'ran')");
    writeFileSync(observation, JSON.stringify({ status: "OBSERVED", result: { proposedCommands: ["node marker.cjs", "node marker.cjs"] } }));

    const result = spawnSync(process.execPath, [
      "--import",
      "tsx",
      join(ROOT, "src", "client", "cli.ts"),
      "verify-savings",
      "--full",
      "node marker.cjs",
      "--repo",
      dir,
      "--selected-from-report",
      observation,
      "--out",
      join(dir, "report.json"),
    ], { encoding: "utf8" });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /DiffCI verify-savings failed: .*exactly one non-empty proposed command/);
    assert.equal(existsSync(marker), false);
  });

  it("does not advertise faster execution when either command failed", () => {
    for (const [fullExit, selectedExit] of [[0, 1], [1, 0], [1, 1]]) {
      const report = buildReport({ cwd: "/repo", timeoutMs: 1000,
        selection: { source: "manual" },
        full: measurement("full", fullExit!, 1000),
        selected: measurement("selected", selectedExit!, 10),
      });
      assert.match(formatVerifySavingsSummary(report), /comparison invalid/);
      assert.doesNotMatch(formatVerifySavingsSummary(report), /faster/);
      assert.match(renderMarkdown(report), /Comparison invalid: command failure/);
    }
  });
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
    assert.equal(report.comparison.grossPercentChange, 60);
    assert.equal(report.comparison.fullCommandSucceeded, true);
    assert.equal(report.comparison.selectedCommandSucceeded, true);
    const summary = formatVerifySavingsSummary(report);
    assert.match(summary, /test execution 60\.0% faster/);
    assert.match(summary, /net including analysis: 35\.0% faster/);
    assert.match(summary, /full: 1\.00s/);
    assert.match(summary, /selected: 400ms \+ analysis 250ms = 650ms/);
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
