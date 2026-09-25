import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { inferFullCommand, inferSelectedCommand } from "../../src/client/full-command.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(ROOT, "src", "client", "cli.ts");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function write(root: string, path: string, contents: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

describe("automatic check timing", () => {
  it("uses the declared tsx loader for selected TypeScript tests", () => {
    const dir = mkdtempSync(join(tmpdir(), "diffci-check-tsx-"));
    try {
      write(dir, "package.json", JSON.stringify({ scripts: { test: 'node --test tests/a.test.mjs && tsx --conditions react-server --test "src/**/*.test.ts"' } }));
      assert.deepEqual(inferSelectedCommand(dir, "node --test src/a.test.ts", ["src/a.test.ts"]), {
        command: "npx --no-install tsx --conditions react-server --test src/a.test.ts",
        reason: "TypeScript node:test runner from package.json test script",
      });
      assert.equal(inferSelectedCommand(dir, "node --test tests/a.test.mjs", ["tests/a.test.mjs"]).command, "node --test tests/a.test.mjs");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("infers a Maven command with the same configured goal and profiles as selection", () => {
    const dir = mkdtempSync(join(tmpdir(), "diffci-full-maven-"));
    try {
      write(dir, "pom.xml", "<project/>");
      write(dir, "diffci.json", JSON.stringify({ maven: { goal: "verify", profiles: ["run-its"] } }));
      assert.deepEqual(inferFullCommand(dir), {
        command: "mvn -P run-its verify",
        reason: "Maven goal and profiles from DiffCI configuration",
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("runs inferred full and selected test commands and writes a savings report", () => {
    const dir = mkdtempSync(join(tmpdir(), "diffci-check-exec-"));
    const out = join(tmpdir(), `diffci-check-${Date.now()}-${process.pid}.json`);
    try {
      git(dir, "init", "--quiet");
      git(dir, "config", "user.email", "test@diffci.local");
      git(dir, "config", "user.name", "Test");
      git(dir, "config", "core.autocrlf", "false");
      write(dir, "package.json", JSON.stringify({ name: "fixture", type: "module", scripts: { test: "node --test" } }));
      write(dir, "tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", allowJs: true }, include: ["src", "test"] }));
      write(dir, "src/alpha.js", "export const alpha = () => 1;\n");
      write(dir, "src/beta.js", "export const beta = () => 2;\n");
      write(dir, "test/alpha.test.js", "import test from 'node:test'; import assert from 'node:assert/strict'; import {alpha} from '../src/alpha.js'; test('alpha', () => assert.equal(alpha(), 1));\n");
      write(dir, "test/beta.test.js", "import test from 'node:test'; import assert from 'node:assert/strict'; import {beta} from '../src/beta.js'; test('beta', () => assert.equal(beta(), 2));\n");
      git(dir, "add", "-A");
      git(dir, "commit", "--quiet", "-m", "initial");
      const base = git(dir, "rev-parse", "HEAD");
      write(dir, "src/alpha.js", "export const alpha = () => 3;\n");
      write(dir, "test/alpha.test.js", "import test from 'node:test'; import assert from 'node:assert/strict'; import {alpha} from '../src/alpha.js'; test('alpha', () => assert.equal(alpha(), 3));\n");
      git(dir, "add", "-A");
      git(dir, "commit", "--quiet", "-m", "change alpha");
      const head = git(dir, "rev-parse", "HEAD");

      const run = spawnSync(process.execPath, ["--import", "tsx", CLI, "check", "--repo", dir, "--base", base, "--head", head, "--out", out], { cwd: ROOT, encoding: "utf8", timeout: 120_000 });
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.match(run.stdout, /running full and selected validation/);
      assert.match(run.stdout, /DiffCI verify-savings: .*%/);
      const savingsPath = out.replace(/\.json$/, "-savings.json");
      assert.equal(existsSync(savingsPath), true);
      const savings = JSON.parse(readFileSync(savingsPath, "utf8"));
      assert.equal(savings.full.exitCode, 0);
      assert.equal(savings.selected.exitCode, 0);
      assert.equal(savings.full.command, "npm test");
      assert.match(savings.selected.command, /node --test/);
      assert.equal(savings.schema, "diffci.verifySavings.v3");
      assert.equal(savings.protocol.repetitions, 1);
      assert.equal(savings.comparison.performanceEvidence, "PRELIMINARY");
      assert.match(savings.runnerIdentity.fingerprintSha256, /^[a-f0-9]{64}$/);
      assert.equal(savings.provenance.baseSha, base);
      assert.equal(savings.provenance.headSha, head);
      assert.match(savings.provenance.observationSha256, /^[a-f0-9]{64}$/);
      assert.equal(savings.provenance.beforeFull.headSha, head);
      assert.equal(savings.provenance.afterFull.headSha, head);
      assert.equal(savings.provenance.afterSelected.headSha, head);
      assert.equal(savings.provenance.checkoutStable, true);
      assert.equal(savings.comparison.evidenceValid, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      for (const path of [out, out.replace(/\.json$/, "-savings.json"), out.replace(/\.json$/, "-savings.md")]) {
        try { rmSync(path, { force: true }); } catch { /* best effort */ }
      }
    }
  });
});
