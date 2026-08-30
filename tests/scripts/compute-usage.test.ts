/**
 * Does the compute meter measure compute?
 *
 * These are calibration tests in the same sense as the timeout ones: before any savings figure rests on
 * CPU-seconds, the thing producing them has to be shown to respond to CPU and to stay silent when it
 * cannot measure. A meter that quietly reports plausible numbers is worse than one that reports none.
 *
 * The measurement is Linux-only (`/proc/self/stat`), so the behavioural cases skip on the developer
 * host and run for real in the canonical environment - which is where compute evidence is produced.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { CLOCK_TICKS_PER_SECOND, cpuSecondsBetween, readChildCpuTicks } from "../../scripts/compute-usage.js";
import { execNodeScript } from "../../scripts/process-exec.js";

const scratch = mkdtempSync(join(tmpdir(), "diffci-compute-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const onLinux = process.platform === "linux";

function runScript(body: string, timeoutMs = 60_000) {
  const file = join(scratch, `c${Math.abs([...body].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 0))}.cjs`);
  writeFileSync(file, body);
  return execNodeScript(file, [], { timeoutMs });
}

describe("cpuSecondsBetween", () => {
  it("returns undefined when either snapshot is missing, never zero", () => {
    // "Could not measure" must not become "consumed nothing" - that understates cost in exactly the
    // direction that flatters DiffCI.
    assert.equal(cpuSecondsBetween(undefined, { cutime: 10, cstime: 5 }), undefined);
    assert.equal(cpuSecondsBetween({ cutime: 10, cstime: 5 }, undefined), undefined);
    assert.equal(cpuSecondsBetween(undefined, undefined), undefined);
  });

  it("converts a tick delta into seconds", () => {
    const before = { cutime: 100, cstime: 50 };
    const after = { cutime: 400, cstime: 150 };
    // (400-100) + (150-50) = 400 ticks
    assert.equal(cpuSecondsBetween(before, after), 400 / CLOCK_TICKS_PER_SECOND);
  });

  it("reports zero for a genuinely idle interval, which is different from unmeasurable", () => {
    const same = { cutime: 7, cstime: 3 };
    assert.equal(cpuSecondsBetween(same, { ...same }), 0);
  });

  it("refuses a negative delta rather than reporting impossible work", () => {
    // The counters are monotonic; a decrease means the reading cannot be trusted.
    assert.equal(cpuSecondsBetween({ cutime: 100, cstime: 100 }, { cutime: 50, cstime: 50 }), undefined);
  });
});

describe("reading child CPU from the running process", { skip: !onLinux }, () => {
  it("is available at all", () => {
    assert.notEqual(readChildCpuTicks(), undefined, "/proc/self/stat should be readable on linux");
  });

  it("rises when a child burns CPU, and the meter tracks it", () => {
    // A busy loop: wall time and CPU time should both be substantial and roughly comparable, because
    // the work is single-threaded and compute-bound.
    const busy = runScript(`const end = Date.now() + 1500; while (Date.now() < end) { Math.sqrt(Math.random()); }`);
    assert.equal(busy.status, 0);
    assert.notEqual(busy.cpuSeconds, undefined, "a compute-bound child must produce a measurement");
    assert.ok(busy.cpuSeconds! > 0.5, `expected >0.5 CPU-seconds for a 1.5s busy loop, got ${busy.cpuSeconds}`);
  });

  it("distinguishes waiting from working - the reason wall time is the wrong unit", () => {
    // Same wall time, almost no CPU. If the meter reported wall time in disguise, these would match.
    const idle = runScript(`setTimeout(() => {}, 1500);`);
    assert.equal(idle.status, 0);
    assert.notEqual(idle.cpuSeconds, undefined);
    assert.ok(idle.ms > 1200, `the sleeping child really did take wall time: ${idle.ms}ms`);
    assert.ok(
      idle.cpuSeconds! < 0.5,
      `a sleeping child must not be charged for waiting: ${idle.cpuSeconds} CPU-seconds over ${idle.ms}ms`,
    );
  });

  it("counts CPU spent by a grandchild, not just the direct child", () => {
    // Test runners fork workers. If only the direct child were counted, every parallel suite would be
    // measured as nearly free - the single most dangerous way to overstate savings.
    const worker = join(scratch, "burn-worker.cjs");
    writeFileSync(worker, `const end = Date.now() + 1200; while (Date.now() < end) { Math.sqrt(Math.random()); }\n`);
    const parent = runScript(
      `const { spawnSync } = require("node:child_process");
spawnSync(process.execPath, [${JSON.stringify(worker)}], { stdio: "ignore" });`,
    );
    assert.equal(parent.status, 0);
    assert.notEqual(parent.cpuSeconds, undefined);
    assert.ok(
      parent.cpuSeconds! > 0.5,
      `a grandchild's CPU must be attributed to the tree, got ${parent.cpuSeconds} CPU-seconds`,
    );
  });
});

describe("on a platform without /proc", { skip: onLinux }, () => {
  it("reports nothing rather than fabricating a number", () => {
    assert.equal(readChildCpuTicks(), undefined);
    assert.equal(runScript(`process.exit(0);`).cpuSeconds, undefined);
  });
});
