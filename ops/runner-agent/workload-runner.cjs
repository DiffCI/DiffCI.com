#!/usr/bin/env node
"use strict";
/**
 * R2 workload runner - the ONLY thing that ever actually executes a repository/setup command inside a
 * real runner container. Deliberately plain, dependency-free JavaScript (no build step, no TypeScript
 * transpilation needed inside the container - just the Node binary already present on the Sandbox
 * image) so its content can be embedded verbatim as a trusted string constant and written into the
 * container filesystem by the bootstrap agent, exactly like the bootstrap script itself.
 *
 * Invoked as: node workload-runner.js <job-spec.json>
 *
 * Uses child_process.spawn(executable, argsArray, {...}) with NO shell involved at all - this is
 * real execve()-semantics process execution (Part 3): the OS receives an argv array directly, there is
 * no shell to parse metacharacters out of any argument, so there is nothing to inject into, by
 * construction - not even the shell-quoting escape hatch command-policy.ts uses for the bootstrap
 * agent's own orchestration calls is needed here.
 *
 * Job-spec shape (all fields required unless noted):
 *   {
 *     steps: [{ executable: string, args: string[], cwd?: string, expectedStdout?: string }],  // each
 *       already policy-validated server-side against the SAME allowlist as src/runner/command-policy.ts
 *       (this file keeps its own copy of the allowlist as a deliberate, disclosed duplication - see
 *       the comment on ALLOWED_EXECUTABLES below - so this file remains a real, standalone safety
 *       backstop even if a bug ever let an unvalidated step reach it). `expectedStdout`, when set
 *       (R2 Part 11), is compared against the step's OWN trimmed stdout - a mismatch is treated as a
 *       real step failure even if the process itself exited 0 (e.g. `git rev-parse HEAD` succeeding
 *       is not enough; it must echo the EXACT requested commit SHA, or acquisition is rejected before
 *       any dependency install or test execution ever runs).
 *     uid: number, gid: number,           // the unprivileged diffci-runner identity to drop to
 *     timeoutMsPerStep: number,
 *     maxOutputBytes: number,
 *   }
 *
 * Result (the ONLY thing printed to this process's own stdout, one JSON line):
 *   { steps: [{ executable, exitCode, signal, timedOut, outputTruncated, durationMs, stdout, stderr,
 *               expectedStdoutMismatch? }],
 *     failedAtStep: number | null }      // index of the first non-final step that failed, if any
 */
const { spawn } = require("node:child_process");
const { readFileSync } = require("node:fs");

// Deliberately duplicated from src/runner/command-policy.ts's ALLOWED_EXECUTABLES - this file has no
// build step and cannot `import` TypeScript source directly inside the container, so the SAME list is
// kept here by hand. A real, disclosed maintenance cost (change one, must remember to change the
// other) in exchange for this file remaining a genuine standalone backstop, not merely trusting the
// server already validated everything upstream.
const ALLOWED_EXECUTABLES = new Set(["node", "npm", "npx", "git", "go"]);
const FORBIDDEN_ENV_KEY_SUBSTRINGS = ["TOKEN", "SECRET", "PASSWORD", "CREDENTIAL", "API_KEY", "APIKEY", "PRIVATE_KEY", "AUTH"];
// Deliberately duplicated from src/runner/env-policy.ts's SAFE_ENV_ALLOWLIST - same no-build-step
// reasoning as ALLOWED_EXECUTABLES above.
const SAFE_ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "NODE_ENV", "NPM_CONFIG_CACHE"];
const COMMAND_ENV_KEYS = new Set(["GOOS", "GOARCH", "CGO_ENABLED", "GOFLAGS", "GOTOOLCHAIN", "GOPROXY", "GOSUMDB", "GOWORK", "GOENV"]);

function validateStep(step) {
  if (!step || typeof step.executable !== "string" || !ALLOWED_EXECUTABLES.has(step.executable)) {
    throw new Error(`workload-runner: step executable "${step && step.executable}" is not in the allowlist`);
  }
  if (!Array.isArray(step.args) || step.args.some((a) => typeof a !== "string" || a.includes("\0"))) {
    throw new Error("workload-runner: step args must be an array of null-byte-free strings");
  }
  if (step.env !== undefined && (step.env === null || typeof step.env !== "object" || Array.isArray(step.env) || Object.entries(step.env).some(([key, value]) => !COMMAND_ENV_KEYS.has(key) || typeof value !== "string" || value.includes("\0")))) {
    throw new Error("workload-runner: step environment is not allowed");
  }
  if (step.cwd !== undefined && (typeof step.cwd !== "string" || /(^|\/)\.\.(\/|$)/.test(step.cwd))) {
    throw new Error(`workload-runner: step cwd "${step.cwd}" is invalid or contains a path-traversal segment`);
  }
}

/** Builds the workload's environment from THIS process's own process.env (the bootstrap agent's real
 * environment, including DIFFCI_RUNNER_TOKEN) - by construction, ONLY allowlisted keys are ever copied
 * out (R2 Part 8/18): the token, and anything else not explicitly listed, simply never reaches this
 * object, regardless of what else is present in the agent's own env. */
function buildWorkloadEnv() {
  const result = { CI: "true" };
  for (const key of SAFE_ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) result[key] = process.env[key];
  }
  for (const key of Object.keys(result)) {
    const upper = key.toUpperCase();
    if (FORBIDDEN_ENV_KEY_SUBSTRINGS.some((f) => upper.includes(f))) {
      throw new Error(`workload-runner: refusing to include env key "${key}" - matches a forbidden credential-shaped pattern (this should be structurally impossible given SAFE_ENV_ALLOWLIST's own contents - a real bug if it ever fires)`);
    }
  }
  return result;
}

/** Runs one step with a hard timeout, a bounded output cap, and (on POSIX) kills the WHOLE process
 * group on timeout/over-limit, not just the direct child - a child that itself forks (e.g. `npm test`
 * spawning a real test-runner subprocess) cannot outlive its parent's own termination (Part 21). */
function runStep(step, sharedEnv, uid, gid, timeoutMs, maxOutputBytes) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;

    const child = spawn(step.executable, step.args, {
      cwd: step.cwd,
      env: { ...sharedEnv, ...step.env },
      uid,
      gid,
      detached: process.platform !== "win32", // POSIX: own process group, killable as a unit - see killTree()
      stdio: ["ignore", "pipe", "pipe"],
    });

    function killTree(signal) {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // already gone - fine, matches the same idempotent-teardown discipline as the rest of R1/R2.
      }
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killTree("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      if (stdout.length >= maxOutputBytes) {
        stdoutTruncated = true;
        killTree("SIGKILL"); // Part 19: do not let a runaway process keep consuming memory once over cap
        return;
      }
      stdout += chunk.toString("utf8");
      if (stdout.length > maxOutputBytes) {
        stdout = stdout.slice(0, maxOutputBytes);
        stdoutTruncated = true;
      }
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length >= maxOutputBytes) {
        stderrTruncated = true;
        killTree("SIGKILL");
        return;
      }
      stderr += chunk.toString("utf8");
      if (stderr.length > maxOutputBytes) {
        stderr = stderr.slice(0, maxOutputBytes);
        stderrTruncated = true;
      }
    });

    function finish(exitCode, signal) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        executable: step.executable,
        exitCode: exitCode === null ? null : exitCode,
        signal: signal || null,
        timedOut,
        outputTruncated: stdoutTruncated || stderrTruncated,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
      });
    }

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ executable: step.executable, exitCode: null, signal: null, timedOut, outputTruncated: false, durationMs: Date.now() - startedAt, stdout, stderr: `spawn error: ${err.message}` });
    });
    child.on("exit", finish);
  });
}

async function main() {
  const specPath = process.argv[2];
  if (!specPath) {
    console.error("usage: node workload-runner.js <job-spec.json>");
    process.exit(2);
  }
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  for (const step of spec.steps) validateStep(step);
  const workloadEnv = buildWorkloadEnv();

  const results = [];
  let failedAtStep = null;
  for (let i = 0; i < spec.steps.length; i++) {
    const step = spec.steps[i];
    const result = await runStep(step, workloadEnv, spec.uid, spec.gid, spec.timeoutMsPerStep, spec.maxOutputBytes);
    if (step.expectedStdout !== undefined) {
      result.expectedStdoutMismatch = result.stdout.trim() !== step.expectedStdout;
    }
    results.push(result);
    const isLastStep = i === spec.steps.length - 1;
    const stepFailed = result.exitCode !== 0 || result.expectedStdoutMismatch === true;
    if (!isLastStep && stepFailed) {
      failedAtStep = i;
      break; // acquisition/setup failed (or SHA verification mismatched) - no point running later steps
    }
  }

  process.stdout.write(JSON.stringify({ steps: results, failedAtStep }));
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ steps: [], failedAtStep: null, fatalError: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
