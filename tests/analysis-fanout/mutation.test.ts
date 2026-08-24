import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { selectFileToMutate } from "../../src/analysis-fanout/mutation.js";

function initRepo(dir: string): void {
  execSync("git init --quiet", { cwd: dir });
  execSync('git config user.email "test@example.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
}

function commit(dir: string, message: string): string {
  execSync("git add -A", { cwd: dir });
  execSync(`git commit --quiet -m "${message}"`, { cwd: dir });
  return execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
}

describe("selectFileToMutate (whole-file revert-to-base mutation strategy)", () => {
  it("picks the first candidate that existed at baseSha and returns its exact base content", () => {
    const dir = mkdtempSync(join(tmpdir(), "diffci-mutation-"));
    try {
      initRepo(dir);
      writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
      const baseSha = commit(dir, "base");
      writeFileSync(join(dir, "a.ts"), "export const a = 2; // regression\n");
      commit(dir, "change a");

      const candidate = selectFileToMutate(dir, baseSha, ["a.ts"]);
      assert.ok(candidate);
      assert.equal(candidate!.path, "a.ts");
      assert.equal(candidate!.baseContent, "export const a = 1;\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips a candidate that did not exist at baseSha (newly added file) and falls through to the next", () => {
    const dir = mkdtempSync(join(tmpdir(), "diffci-mutation-newfile-"));
    try {
      initRepo(dir);
      writeFileSync(join(dir, "existing.ts"), "export const x = 1;\n");
      const baseSha = commit(dir, "base");
      writeFileSync(join(dir, "brand-new.ts"), "export const y = 1;\n");
      writeFileSync(join(dir, "existing.ts"), "export const x = 2;\n");
      commit(dir, "add new + change existing");

      const candidate = selectFileToMutate(dir, baseSha, ["brand-new.ts", "existing.ts"]);
      assert.ok(candidate);
      assert.equal(candidate!.path, "existing.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined (never fabricates a candidate) when every changed file was newly added", () => {
    const dir = mkdtempSync(join(tmpdir(), "diffci-mutation-allnew-"));
    try {
      initRepo(dir);
      writeFileSync(join(dir, "unrelated.ts"), "export const z = 1;\n");
      const baseSha = commit(dir, "base");
      writeFileSync(join(dir, "brand-new.ts"), "export const y = 1;\n");
      commit(dir, "add new only");

      const candidate = selectFileToMutate(dir, baseSha, ["brand-new.ts"]);
      assert.equal(candidate, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined for an empty candidate list", () => {
    const dir = mkdtempSync(join(tmpdir(), "diffci-mutation-empty-"));
    try {
      initRepo(dir);
      writeFileSync(join(dir, "a.ts"), "x\n");
      const baseSha = commit(dir, "base");
      assert.equal(selectFileToMutate(dir, baseSha, []), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
