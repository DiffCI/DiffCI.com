import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { ExecResultLike, SandboxLike } from "../../src/analysis-fanout/sandbox-like.js";
import { generateAdoptionChanges } from "../../src/install/adoption-generator.js";

const GENERATED = {
  "package.json": "{\"devDependencies\":{\"@diffci.com/diffci\":\"0.2.5\"}}\n",
  "package-lock.json": "{\"lockfileVersion\":3}\n",
  ".github/workflows/diffci.yml": "name: DiffCI observation\n",
};

function fakeSandbox(options: { unexpected?: string; failOn?: string } = {}): SandboxLike & { commands: Array<{ command: string; env?: Record<string, string> }>; destroyed: boolean } {
  const state = {
    commands: [] as Array<{ command: string; env?: Record<string, string> }>,
    destroyed: false,
    async exec(command: string, execOptions?: { env?: Record<string, string> }): Promise<ExecResultLike> {
      state.commands.push({ command, env: execOptions?.env });
      if (options.failOn && command.includes(options.failOn)) return { success: false, exitCode: 1, stdout: "", stderr: "failed safely" };
      if (command === "git status --porcelain --untracked-files=all") {
        const lines = Object.keys(GENERATED).map((path) => ` M ${path}`);
        if (options.unexpected) lines.push(`?? ${options.unexpected}`);
        return { success: true, exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
      }
      const match = /^git status --porcelain -- (.+)$/.exec(command);
      if (match) return { success: true, exitCode: 0, stdout: match[1]! in GENERATED ? ` M ${match[1]}\n` : "", stderr: "" };
      return { success: true, exitCode: 0, stdout: "", stderr: "" };
    },
    async readFile(path: string) {
      const relative = path.replace("/workspace/diffci-adoption/repo/", "") as keyof typeof GENERATED;
      return { content: GENERATED[relative] };
    },
    async destroy() { state.destroyed = true; },
    async writeFile() { return { success: true }; },
    async startProcess() { return { id: "unused", status: "unused" }; },
    async getProcess() { return null; },
    async getProcessLogs() { return { stdout: "", stderr: "" }; },
    async killProcess() {},
  };
  return state;
}

describe("isolated adoption generation", () => {
  it("clones with a token in the process environment, initializes, verifies, and exports only allowlisted files", async () => {
    const sandbox = fakeSandbox();
    const changes = await generateAdoptionChanges(sandbox, {
      repository: "acme/app", baseBranch: "main", installationToken: "secret-token", diffciVersion: "0.2.5",
    });
    assert.deepEqual(changes, Object.entries(GENERATED).map(([path, content]) => ({ path, content })));
    const clone = sandbox.commands.find((entry) => entry.command.startsWith("git clone"))!;
    assert.equal(clone.command.includes("secret-token"), false, "the installation token must not appear in argv or logs");
    assert.equal(clone.env?.GIT_CONFIG_VALUE_0, "Authorization: Bearer secret-token");
    assert.ok(sandbox.commands.some((entry) => entry.command.includes("init --install --workflow")));
    assert.ok(sandbox.commands.some((entry) => entry.command.includes("verify-workflow")));
    assert.equal(sandbox.destroyed, true);
  });

  it("refuses non-allowlisted mutations and always destroys the workspace", async () => {
    const sandbox = fakeSandbox({ unexpected: "postinstall-output.txt" });
    await assert.rejects(() => generateAdoptionChanges(sandbox, {
      repository: "acme/app", baseBranch: "main", installationToken: "token", diffciVersion: "0.2.5",
    }), /non-allowlisted files/);
    assert.equal(sandbox.destroyed, true);
  });

  it("destroys the workspace when installation fails", async () => {
    const sandbox = fakeSandbox({ failOn: "init --install" });
    await assert.rejects(() => generateAdoptionChanges(sandbox, {
      repository: "acme/app", baseBranch: "main", installationToken: "token", diffciVersion: "0.2.5",
    }), /failed safely/);
    assert.equal(sandbox.destroyed, true);
  });
});
