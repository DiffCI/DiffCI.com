/**
 * Calibration of the instrument, not of DiffCI.
 *
 * The validation machinery has now been caught twice producing a stronger result than reality
 * warranted: ANSI-coloured output defeated result interpretation, and an ignored exit status produced
 * an actual false-green qualification. Both are fixed. These tests exist so a third way is caught by a
 * suite that runs in seconds rather than by a forty-minute repository run that happens to look wrong.
 *
 * Every case below is a real child process with a known, deliberately constructed behaviour, and the
 * assertion is about what the harness concludes from it.
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { classifyExecution, isGreenExecution } from "../../scripts/execution-verdict.js";
import { parseTestOutput } from "../../scripts/test-output-parsers.js";

const scratch = mkdtempSync(join(tmpdir(), "diffci-calibration-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** Writes a node script and runs it exactly as the harness runs a test command. */
function runScript(body: string, timeoutMs = 5000): { status: number | null; out: string; ms: number } {
  const file = join(scratch, `s${Math.abs(hash(body))}.cjs`);
  writeFileSync(file, body);
  const started = Date.now();
  const r = spawnSync(process.execPath, [file], { encoding: "utf8", timeout: timeoutMs });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, ms: Date.now() - started };
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/** What the harness concludes end to end: run it, parse it, classify it. */
function verdictOf(body: string, timeoutMs?: number) {
  const run = runScript(body, timeoutMs);
  const parsed = parseTestOutput(run.out);
  return { ...run, parsed, verdict: classifyExecution(run.status, parsed.failures) };
}

describe("harness calibration: what a real process makes the harness conclude", () => {
  it("child exits 0 with a green summary -> GREEN", () => {
    const v = verdictOf(`console.log(" Test Files  3 passed (3)\\n      Tests  42 passed (42)"); process.exit(0);`);
    assert.equal(v.parsed.failures, 0);
    assert.equal(v.verdict, "GREEN");
    assert.equal(isGreenExecution(v.status, v.parsed.failures), true);
  });

  it("child exits 1 reporting failures -> RED", () => {
    const v = verdictOf(`console.log("      Tests  2 failed | 40 passed (42)"); process.exit(1);`);
    assert.equal(v.parsed.failures, 2);
    assert.equal(v.verdict, "RED");
  });

  it("child exits 1 while the readable summary says zero -> CONTRADICTORY_EXECUTION_EVIDENCE", () => {
    // The TanStack case, reduced: an orchestrator prints a passing project's summary first and fails
    // overall. Qualifying this was one verdict away from admitting a never-green baseline.
    const v = verdictOf(
      `console.log("      Tests  2 passed (2)");
console.log("> nx run @scope/other:\\"test:lib\\"");
console.log("NX   Running target test:lib for 26 projects and 9 tasks they depend on failed");
process.exit(1);`,
    );
    assert.equal(v.parsed.failures, 0, "the parser reads the first summary, which passed");
    assert.equal(v.verdict, "CONTRADICTORY_EXECUTION_EVIDENCE");
    assert.equal(isGreenExecution(v.status, v.parsed.failures), false, "must never qualify");
  });

  it("an ANSI-coloured FAILING summary -> RED, not unreadable and never green", () => {
    // Colour defeated the parser once already. The dangerous direction is a hidden failure count.
    const v = verdictOf(
      `console.log("\\u001B[2m      Tests \\u001B[22m \\u001B[31m3 failed\\u001B[39m | \\u001B[32m39 passed\\u001B[39m (42)"); process.exit(1);`,
    );
    assert.equal(v.parsed.framework, "vitest");
    assert.equal(v.parsed.failures, 3);
    assert.equal(v.verdict, "RED");
  });

  it("an ANSI-coloured PASSING summary with a clean exit -> GREEN", () => {
    const v = verdictOf(`console.log("\\u001B[2m      Tests \\u001B[22m \\u001B[32m42 passed\\u001B[39m (42)"); process.exit(0);`);
    assert.equal(v.verdict, "GREEN");
  });

  it("output with no summary at all -> UNREADABLE, never zero failures", () => {
    const v = verdictOf(`console.log("building..."); process.exit(0);`);
    assert.equal(v.parsed.failures, undefined);
    assert.equal(v.verdict, "UNREADABLE");
    assert.equal(isGreenExecution(v.status, v.parsed.failures), false, "could not tell is not nothing failed");
  });

  it("a child that hangs is bounded by the timeout, and its verdict is never green", () => {
    const v = verdictOf(`setTimeout(() => {}, 60000);`, 2000);
    assert.ok(v.ms < 20_000, `expected the timeout to bound the run, took ${v.ms}ms`);
    assert.equal(v.status, null, "a killed process has no exit status");
    assert.equal(v.verdict, "UNREADABLE");
    assert.equal(isGreenExecution(v.status, v.parsed.failures), false);
  });

  it("a child that prints a green summary and THEN hangs is still not green", () => {
    // The nastiest shape: everything looks finished, the process never exits. A killed process has
    // status null, and null is not zero.
    const v = verdictOf(`console.log("      Tests  42 passed (42)"); setTimeout(() => {}, 60000);`, 2000);
    assert.equal(v.parsed.failures, 0);
    assert.equal(v.status, null);
    assert.equal(v.verdict, "CONTRADICTORY_EXECUTION_EVIDENCE", "killed, so it did not succeed");
    assert.equal(isGreenExecution(v.status, v.parsed.failures), false);
  });

  it("a child whose GRANDCHILD outlives it is still bounded by the timeout", () => {
    // The open question behind a 131-minute qualification run: does `timeout` bound a process TREE, or
    // only the direct child? A surviving grandchild holding the stdio pipe is the classic way a
    // supposedly bounded command runs forever. Asserted here so the answer is measured on whatever
    // platform runs the suite rather than assumed - it does NOT hold identically everywhere.
    const grandchild = join(scratch, "grandchild.cjs");
    writeFileSync(grandchild, `setTimeout(() => {}, 60000);\n`);
    const v = verdictOf(
      `const { spawn } = require("node:child_process");
spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: "inherit", detached: true }).unref();
setTimeout(() => {}, 60000);`,
      2000,
    );
    assert.ok(v.ms < 30_000, `the timeout did not bound the process tree: took ${v.ms}ms`);
    assert.equal(isGreenExecution(v.status, v.parsed.failures), false);
  });
});

describe("the classification matrix, exhaustively", () => {
  it("never reports green unless the process exited 0 AND a summary was read", () => {
    for (const status of [0, 1, 2, 127, null]) {
      for (const failures of [undefined, 0, 1, 99]) {
        const green = isGreenExecution(status, failures);
        assert.equal(green, status === 0 && failures === 0, `status=${String(status)} failures=${String(failures)}`);
      }
    }
  });

  it("treats a signal-killed process as failure, never as success", () => {
    assert.equal(classifyExecution(null, 0), "CONTRADICTORY_EXECUTION_EVIDENCE");
    assert.equal(classifyExecution(null, undefined), "UNREADABLE");
    assert.equal(classifyExecution(null, 5), "RED");
  });

  it("keeps a failure count that the exit status agrees with", () => {
    assert.equal(classifyExecution(1, 3), "RED");
    // A runner that reports failures but exits 0 is still RED: the count is the specific evidence.
    assert.equal(classifyExecution(0, 3), "RED");
  });
});
