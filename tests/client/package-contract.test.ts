import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("npm package contract", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    name?: string;
    private?: boolean;
    bin?: Record<string, string>;
    files?: string[];
    scripts?: Record<string, string>;
    bundleDependencies?: string[];
    dependencies?: Record<string, string>;
  };

  it("publishes a diffci binary backed by the client build", () => {
    assert.equal(pkg.name, "@diffci.com/diffci");
    assert.equal(pkg.private, false);
    assert.equal(pkg.bin?.diffci, "dist-client/src/client/cli.js");
    assert.equal(pkg.scripts?.prepack, "npm run build:client");
    assert.equal(pkg.scripts?.["check:oss-boundary"], "node scripts/check-oss-boundary.mjs");
    assert.ok(pkg.files?.includes("dist-client/src/client"));
    assert.deepEqual(pkg.bundleDependencies, ["@diffci.com/core"]);
    assert.match(pkg.dependencies?.["@diffci.com/core"] ?? "", /^git\+https:\/\/github\.com\/DiffCI\/core\.git#[0-9a-f]{40}$/);
  });

  it("keeps the published package on the OSS core side of the boundary", () => {
    const allowed = new Set([
      "action.yml",
      "dist-client/src/client",
      "README.md",
      "llms.txt",
      "docs/ai-agents.md",
      "docs/agent-adoption-kit.md",
      "docs/agent-adoption-targets.md",
      "docs/codex.md",
      "docs/claude-code.md",
      "docs/cursor.md",
      "docs/copilot.md",
      "docs/grok.md",
      "docs/distribution.md",
      "docs/npm-adoption.md",
      "docs/language-support.md",
      "SECURITY.md",
      "SUPPORT.md",
      "COMMERCIAL.md",
    ]);
    assert.deepEqual(new Set(pkg.files), allowed);
  });

  it("keeps the CLI executable when TypeScript emits it", () => {
    const cli = readFileSync(join(ROOT, "src", "client", "cli.ts"), "utf8");
    assert.match(cli, /^#!\/usr\/bin\/env node\r?\n/, "the npm bin entry needs a shebang");
  });
});
