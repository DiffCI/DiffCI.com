import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { verifyColdWarmEquivalence } from "../../src/shadow/cold-warm-equivalence.js";

function createRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "diffci-equiv-"));
  execSync("git init --quiet", { cwd: dir });
  execSync("git config user.email 'equiv@diffci.local'", { cwd: dir });
  execSync("git config user.name 'Equiv'", { cwd: dir });
  execSync("git config core.autocrlf false", { cwd: dir });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "equiv", version: "1.0.0", type: "module" }));
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", baseUrl: ".", paths: { "@/*": ["./src/*"] }, allowImportingTsExtensions: true, noEmit: true }, include: ["**/*.ts"] }),
  );
  return dir;
}

function commitAll(repoPath: string, message: string): void {
  execSync("git add -A", { cwd: repoPath });
  execSync(`git commit --quiet -m "${message}"`, { cwd: repoPath });
}

function getSha(repoPath: string, ref = "HEAD"): string {
  return execSync(`git rev-parse ${ref}`, { cwd: repoPath, encoding: "utf8" }).trim();
}

describe("cold/warm cache equivalence", () => {
  it("produces the same plan from cold and warm graph paths", async () => {
    const repoPath = createRepo();
    const srcFile = join(repoPath, "src/calc.ts");
    const testFile = join(repoPath, "src/calc.test.ts");
    mkdirSync(dirname(srcFile), { recursive: true });
    writeFileSync(srcFile, "export function calc(n: number): number { return n * 2; }\n");
    writeFileSync(testFile, "import { calc } from './calc'; console.assert(calc(2) === 4);\n");
    commitAll(repoPath, "initial");
    const baseSha = getSha(repoPath);

    writeFileSync(srcFile, "export function calc(n: number): number { return n * 3; }\n");
    commitAll(repoPath, "change");
    const headSha = getSha(repoPath);

    const cacheDir = join(repoPath, "cache");
    try {
      const result = await verifyColdWarmEquivalence(repoPath, cacheDir, baseSha, headSha);
      assert.strictEqual(result.equivalent, true, result.diff);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
