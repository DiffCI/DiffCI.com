import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildR2JobSteps } from "../../src/runner/r2-job-spec.js";

function baseInput(overrides: Partial<Parameters<typeof buildR2JobSteps>[0]> = {}) {
  return {
    cloneUrl: "https://github.com/adityankale190895/DiffCI.com.git",
    commitSha: "a".repeat(40),
    workspaceDir: "/workspace/job-abc123",
    installCommand: { executable: "npm", args: ["ci", "--ignore-scripts"], cwd: "/workspace/job-abc123" },
    testCommand: { executable: "npx", args: ["tsx", "--test", "tests/example.test.ts"], cwd: "/workspace/job-abc123" },
    ...overrides,
  };
}

describe("buildR2JobSteps", () => {
  it("produces clone -> SHA-verify -> install -> test, in order", () => {
    const result = buildR2JobSteps(baseInput());
    assert.equal(result.ok, true);
    const steps = result.steps!;
    assert.equal(steps.length, 4);
    assert.equal(steps[0]!.executable, "git");
    assert.deepEqual(steps[0]!.args.slice(0, 1), ["clone"]);
    assert.equal(steps[1]!.executable, "git");
    assert.deepEqual(steps[1]!.args, ["rev-parse", "HEAD"]);
    assert.equal(steps[1]!.expectedStdout, "a".repeat(40));
    assert.equal(steps[2]!.executable, "npm");
    assert.equal(steps[3]!.executable, "npx");
  });

  it("includes setupSteps before acquisition when provided", () => {
    const result = buildR2JobSteps(baseInput({ setupSteps: [{ executable: "npm", args: ["install", "-g", "pnpm@11.7.0"] }] }));
    assert.equal(result.ok, true);
    assert.equal(result.steps![0]!.args[0], "install");
    assert.equal(result.steps![1]!.executable, "git");
  });

  it("rejects a job spec whose install command uses a disallowed executable, before ever returning steps", () => {
    const result = buildR2JobSteps(baseInput({ installCommand: { executable: "bash", args: ["-c", "npm ci"] } }));
    assert.equal(result.ok, false);
    assert.match(result.error!, /executable_not_allowed/);
    assert.equal(result.steps, undefined);
  });

  it("rejects a job spec whose test command uses a disallowed executable", () => {
    const result = buildR2JobSteps(baseInput({ testCommand: { executable: "sh", args: ["-c", "vitest run"] } }));
    assert.equal(result.ok, false);
  });

  it("real regression scenario: the deepseek-harness dsh-timeout job spec is well-formed and policy-valid", () => {
    const workspaceDir = "/workspace/job-real-experiment";
    const result = buildR2JobSteps({
      cloneUrl: "https://github.com/deepseek-ai/deepseek-harness.git",
      commitSha: "b".repeat(40),
      workspaceDir,
      setupSteps: [{ executable: "npm", args: ["install", "-g", "pnpm@11.7.0"] }],
      installCommand: { executable: "npx", args: ["pnpm@11.7.0", "install", "--filter", "@deepseek-ai/dsh-timeout...", "--ignore-scripts"], cwd: workspaceDir },
      testCommand: { executable: "npx", args: ["pnpm@11.7.0", "--filter", "@deepseek-ai/dsh-timeout", "test"], cwd: workspaceDir },
    });
    assert.equal(result.ok, true);
    assert.equal(result.steps!.length, 5);
  });
});
