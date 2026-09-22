import { strict as assert } from "node:assert";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(ROOT, "src", "client", "cli.ts");
const PACKAGE_VERSION = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;

function runCli(args: string[], cwd: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], { cwd, encoding: "utf8" });
}

describe("agent-facing CLI commands", () => {
  it("prints check and init as first-class commands", () => {
    const result = runCli(["help"], ROOT);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /diffci init \[--repo <path>\] \[--workflow\] \[--force\]/);
    assert.match(result.stdout, /diffci check \[--repo <path>\]/);
    assert.match(result.stdout, /check analyzes the change, runs inferred full and selected commands/);
  });

  it("initializes AI-agent instruction files without overwriting existing files by default", () => {
    const dir = mkdtempSync(join(tmpdir(), "diffci-agent-init-"));
    try {
      writeFileSync(join(dir, "AGENTS.md"), "# Existing agent policy\n", "utf8");

      const result = runCli(["init", "--repo", dir, "--workflow"], ROOT);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /kept AGENTS\.md \(already exists\)/);
      assert.match(result.stdout, /wrote CLAUDE\.md/);
      assert.match(result.stdout, /wrote \.github\/workflows\/diffci\.yml/);
      assert.equal(readFileSync(join(dir, "AGENTS.md"), "utf8"), "# Existing agent policy\n");
      assert.match(readFileSync(join(dir, "CLAUDE.md"), "utf8"), /npx @diffci\.com\/diffci@latest check/);
      assert.match(readFileSync(join(dir, ".cursor", "rules", "diffci.mdc"), "utf8"), /alwaysApply: true/);
      assert.match(readFileSync(join(dir, ".github", "copilot-instructions.md"), "utf8"), /Repository CI\/CD Validation/);
      assert.match(readFileSync(join(dir, "diffci.config.json"), "utf8"), /"sendReports": false/);
      assert.match(readFileSync(join(dir, ".github", "workflows", "diffci.yml"), "utf8"), new RegExp(`npx @diffci\\.com/diffci@${PACKAGE_VERSION.replaceAll(".", "\\.")} observe --no-send`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not create a workflow unless requested", () => {
    const dir = mkdtempSync(join(tmpdir(), "diffci-agent-no-workflow-"));
    try {
      const result = runCli(["init", "--repo", dir], ROOT);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /skipped \.github\/workflows\/diffci\.yml/);
      assert.equal(existsSync(join(dir, ".github", "workflows", "diffci.yml")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
