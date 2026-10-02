import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { npmDistTagForVersion } from "../../scripts/npm-dist-tag.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(ROOT, "scripts", "npm-dist-tag.mjs");
const PACKAGE_VERSION = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;

describe("npm prerelease distribution tags", () => {
  it("publishes release candidates and unknown prereleases on next", () => {
    assert.equal(npmDistTagForVersion("0.3.0-rc.1"), "next");
    assert.equal(npmDistTagForVersion("0.3.0-preview.4"), "next");
  });

  it("preserves explicit alpha and beta channels", () => {
    assert.equal(npmDistTagForVersion("0.3.0-alpha.1"), "alpha");
    assert.equal(npmDistTagForVersion("0.3.0-beta.2"), "beta");
  });

  it("refuses stable or malformed versions", () => {
    assert.throws(() => npmDistTagForVersion("0.3.0"), /prerelease/);
    assert.throws(() => npmDistTagForVersion("latest"), /prerelease/);
  });

  it("prints the tag for GitHub Actions", () => {
    assert.equal(execFileSync(process.execPath, [SCRIPT, "0.3.0-rc.1"], { encoding: "utf8" }).trim(), "next");
  });

  it("dogfoods an unpublished release candidate from source", () => {
    const workflow = readFileSync(join(ROOT, ".github", "workflows", "diffci.yml"), "utf8");
    assert.match(workflow, new RegExp(`npm view "@diffci\\.com/diffci@${PACKAGE_VERSION.replaceAll(".", "\\.")}" version`));
    assert.match(workflow, /node --import tsx src\/client\/cli\.ts observe/);
  });
});
