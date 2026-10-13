import { strict as assert } from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { before, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
before(() => execFileSync(process.execPath, [join(ROOT, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.client.json"], { cwd: ROOT }));
const git = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

async function call(name: string, args: Record<string, unknown>) {
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const child = spawn(process.execPath, [join(ROOT, "dist-client/src/client/mcp.js")], { cwd: ROOT, env, windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  try {
    return await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP timeout: ${stderr}`)), 120_000);
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.stdout.on("data", chunk => {
        stdout += chunk.toString();
        if (stdout.includes("\n")) {
          clearTimeout(timer);
          try { resolve(JSON.parse(stdout.split("\n")[0]!)); } catch (error) { reject(error); }
        }
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) + "\n");
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>(resolve => { child.once("close", () => resolve()); child.kill(); });
    }
  }
}

it("selects the live snapshot without tests, executes affected tests, and fails closed", async () => {
  const repo = mkdtempSync(join(tmpdir(), "diffci-agent-plugin-"));
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  try {
    git(repo, "init", "--quiet");
    git(repo, "config", "user.email", "test@diffci.local");
    git(repo, "config", "user.name", "Test");
    git(repo, "config", "core.autocrlf", "false");
    write("package.json", JSON.stringify({ type: "module", scripts: { test: "node --test" } }));
    write("tsconfig.json", JSON.stringify({ compilerOptions: { allowJs: true, module: "NodeNext", moduleResolution: "NodeNext" }, include: ["src", "test"] }));
    write("src/a.js", "export const a = 1;\n");
    write("src/b.js", "export const b = 2;\n");
    write("test/a.test.js", "import test from 'node:test'; import assert from 'node:assert/strict'; import { a } from '../src/a.js'; test('a',()=>assert.equal(a,1));\n");
    write("test/b.test.js", "import test from 'node:test'; import { b } from '../src/b.js'; test('b',()=>{if(b!==2) throw Error('unrelated failure');});\n");
    git(repo, "add", "-A"); git(repo, "commit", "--quiet", "-m", "initial");
    write("src/a.js", "export const a = 1; // changed\n");
    git(repo, "add", "src/a.js");
    write("src/a.js", "export const a = 1; // unstaged too\n");
    write("notes.txt", "untracked\n");
    const status = git(repo, "status", "--porcelain");
    const index = git(repo, "write-tree");
    for (const name of ["diffci_changed_files", "diffci_select_tests", "diffci_explain_selection"]) {
      const response = await call(name, { repo });
      assert.equal(response.result.isError, false);
      const plan = response.result.structuredContent;
      assert.equal(plan.tests_executed, false);
      if (name !== "diffci_changed_files") {
        assert.equal(plan.selection, "selected");
        assert.deepEqual(plan.selected_tests, ["test/a.test.js"]);
      } else assert.equal(plan.schema, "diffci.agent-changes.v1");
      assert.deepEqual(plan.changed_files, ["notes.txt", "src/a.js"]);
      assert.equal(plan.snapshot.unchanged, true);
    }
    assert.equal(git(repo, "status", "--porcelain"), status);
    assert.equal(git(repo, "write-tree"), index);
    let response = await call("diffci_run_affected_tests", { repo });
    assert.equal(response.result.structuredContent.safe_to_continue, true);
    assert.equal(response.result.structuredContent.tests_selected, 1);
    write("src/a.js", "export const a = 3;\n");
    response = await call("diffci_run_affected_tests", { repo });
    assert.equal(response.result.isError, true);
    assert.equal(response.result.structuredContent.safe_to_continue, false);
    write("tsconfig.json", JSON.stringify({ compilerOptions: { allowJs: true, module: "NodeNext", moduleResolution: "NodeNext", strict: true }, include: ["src", "test"] }));
    response = await call("diffci_select_tests", { repo });
    assert.equal(response.result.structuredContent.selection, "full");
    assert.equal(response.result.structuredContent.tests_selected, 2);
    response = await call("diffci_select_tests", { repo, timeoutMs: "bad" });
    assert.equal(response.error.code, -32602);
    response = await call("nonexistent", { repo });
    assert.equal(response.error.code, -32602);
  } finally { rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

it("ships both agent manifests and their shared skill/MCP configuration in the npm package", () => {
  const root = join(ROOT, "packaging/agent-plugin");
  const portable = JSON.parse(readFileSync(join(root, "plugin.json"), "utf8"));
  const codex = JSON.parse(readFileSync(join(root, ".codex-plugin/plugin.json"), "utf8"));
  const claude = JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(portable.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  assert.equal(portable.name, codex.name);
  assert.equal(codex.name, claude.name);
  assert.equal(portable.version, pkg.version);
  assert.equal(codex.version, pkg.version);
  assert.equal(claude.version, pkg.version);
  assert.deepEqual(portable.extensions["com.openai"].interface, codex.interface);
  assert.equal(codex.author.name, "DiffCI");
  assert.equal(claude.author.name, "DiffCI");
  assert.equal(claude.icon, "./assets/diffci-mark.svg");
  assert.equal(claude.documentationUrl, "https://diffci.com/mcp-server");
  assert.equal(claude.supportUrl, "https://diffci.com/contact");
  assert.equal(claude.privacyPolicyUrl, "https://diffci.com/data-handling");
  assert.equal(claude.termsOfServiceUrl, "https://diffci.com/terms");
  assert.equal(codex.interface.composerIcon, "./assets/diffci-mark.svg");
  assert.ok(existsSync(join(root, "assets/diffci-mark.svg")));
  assert.equal(codex.skills, "./skills/");
  assert.equal(codex.mcpServers, "./.mcp.json");
  assert.match(readFileSync(join(root, "skills/diffci-verify/SKILL.md"), "utf8"), /safe_to_continue/);
  assert.ok((readFileSync(join(root, "README.md"), "utf8").match(/\b\w+\b/g) ?? []).length >= 40);
  const config = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
  const portableConfig = JSON.parse(readFileSync(join(root, "mcp.json"), "utf8"));
  assert.equal(portableConfig.$schema, "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
  assert.deepEqual(portableConfig.mcpServers.diffci, { type: "stdio", ...config.mcpServers.diffci });
  assert.equal(config.mcpServers.diffci.args.at(-1), "diffci-mcp");
  assert.ok(config.mcpServers.diffci.args.includes(`${pkg.name}@${pkg.version}`));
  const marketplace = JSON.parse(readFileSync(join(ROOT, ".agents/plugins/marketplace.json"), "utf8"));
  assert.equal(marketplace.plugins[0].source.path, "./packaging/agent-plugin");

  const claudeMarketplace = JSON.parse(readFileSync(join(ROOT, ".claude-plugin/marketplace.json"), "utf8"));
  assert.equal(claudeMarketplace.name, "diffci-marketplace");
  assert.equal(claudeMarketplace.plugins[0].name, "diffci");
  assert.equal(claudeMarketplace.plugins[0].source, "./packaging/agent-plugin");

  const publicRoot = join(ROOT, "packaging/public-plugin");
  const publicManifest = JSON.parse(readFileSync(join(publicRoot, "plugin.json"), "utf8"));
  const publicMcp = JSON.parse(readFileSync(join(publicRoot, "mcp.json"), "utf8"));
  assert.equal(publicManifest.name, "diffci");
  assert.equal(publicManifest.version, pkg.version);
  assert.equal(publicManifest.extensions["com.openai"].onboardingSkill, "./skills/get-started/SKILL.md");
  assert.equal(publicManifest.extensions["com.openai"].interface.termsOfServiceURL, "https://diffci.com/terms");
  assert.deepEqual(publicMcp.mcpServers.diffci, {
    type: "streamable-http",
    url: "https://diffci.com/mcp/v1",
    extensions: { "com.openai": { auth: { type: "none" } } },
  });
  for (const path of [
    "assets/icon.png",
    "assets/icon-dark.png",
    "assets/logo.png",
    "assets/logo-dark.png",
    "skills/get-started/SKILL.md",
    "skills/diffci-remote/SKILL.md",
    "review/refusal-observation.json",
  ]) assert.ok(existsSync(join(publicRoot, path)), path);

  const packArgs = ["pack", "--dry-run", "--json", "--ignore-scripts"];
  const packed = JSON.parse(execFileSync(process.platform === "win32" ? "cmd.exe" : "npm",
    process.platform === "win32" ? ["/d", "/c", "npm", ...packArgs] : packArgs,
    { cwd: ROOT, encoding: "utf8" }));
  assert.ok(packed[0].files.some((file: { path: string }) => file.path === ".agents/plugins/marketplace.json"));
  assert.ok(packed[0].files.some((file: { path: string }) => file.path === ".claude-plugin/marketplace.json"));
  for (const path of [
    "plugin.json",
    "mcp.json",
    ".codex-plugin/plugin.json",
    ".claude-plugin/plugin.json",
    ".mcp.json",
    "README.md",
    "assets/diffci-mark.svg",
    "skills/diffci-verify/SKILL.md",
  ]) {
    assert.ok(packed[0].files.some((file: { path: string }) => file.path === `packaging/agent-plugin/${path}`), path);
  }
  for (const path of [
    "plugin.json",
    "mcp.json",
    "README.md",
    "SUBMISSION.md",
    "assets/icon.png",
    "assets/icon-dark.png",
    "assets/logo.png",
    "assets/logo-dark.png",
    "skills/get-started/SKILL.md",
    "skills/diffci-remote/SKILL.md",
    "review/refusal-observation.json",
  ]) {
    assert.ok(packed[0].files.some((file: { path: string }) => file.path === `packaging/public-plugin/${path}`), path);
  }
});
