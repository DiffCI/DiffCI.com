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
  };

  it("publishes a diffci binary backed by the client build", () => {
    assert.equal(pkg.name, "@diffci.com/diffci");
    assert.equal(pkg.private, false);
    assert.equal(pkg.bin?.diffci, "dist-client/src/client/cli.js");
    assert.equal(pkg.scripts?.prepack, "npm run build:client");
    assert.equal(pkg.scripts?.["check:oss-boundary"], "node scripts/check-oss-boundary.mjs");
    assert.ok(pkg.files?.includes("dist-client/src/client"));
  });

  it("keeps the published package on the OSS core side of the boundary", () => {
    const allowed = new Set([
      "action.yml",
      "dist-client/src/client",
      "dist-client/src/git",
      "dist-client/src/planner",
      "dist-client/src/repo",
      "README.md",
      "docs/distribution.md",
      "docs/language-support.md",
    ]);
    assert.deepEqual(new Set(pkg.files), allowed);
  });

  it("keeps the CLI executable when TypeScript emits it", () => {
    const cli = readFileSync(join(ROOT, "src", "client", "cli.ts"), "utf8");
    assert.match(cli, /^#!\/usr\/bin\/env node\r?\n/, "the npm bin entry needs a shebang");
  });
});
