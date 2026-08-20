import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { cloneOrUpdateRepo, collectMetadata, isKnownUnsupportedLanguage, repoLocalPath } from "../../../src/research/repository/collector.js";
import type { ResearchRepository } from "../../../src/research/types.js";

// Real finding, 2026-08-20 Stage 0 small batch: lukeed/kleur (plain JS, no tsconfig.json anywhere in
// the repo) made every sampled commit fail outright inside src/repo/graph.ts's createProgram() ("No
// tsconfig.json found in ..."), producing zero records and zero fallback instead of an explicit,
// reported exclusion. This guards the fix: collectMetadata() now excludes such repositories up front,
// with the exact reason, before any analysis is attempted - see
// diffci/docs/research/2026-08-20-stage0-small-batch-report.md.

function repo(primaryLanguage: string): ResearchRepository {
  return { owner: "test-owner", name: "test-repo", primaryLanguage, framework: "unknown", sizeClass: "small" };
}

describe("collectMetadata tsconfig-less-JS exclusion", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "diffci-collector-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("excludes a JavaScript repository with no tsconfig.json anywhere, with the exact reason", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/index.js"), "module.exports = () => {};\n");
    writeFileSync(join(dir, "package.json"), "{}\n");

    const metadata = collectMetadata(repo("javascript"), dir);

    assert.match(metadata.exclusionReason ?? "", /no tsconfig\.json found/);
    assert.equal(metadata.languageSupport.diffciGraphCapable, false);
    assert.match(metadata.languageSupport.reason, /tsconfig/);
  });

  it("does NOT exclude a JavaScript repository that has a tsconfig.json at its root", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/index.js"), "module.exports = () => {};\n");
    writeFileSync(join(dir, "tsconfig.json"), '{"compilerOptions": {"allowJs": true}}\n');

    const metadata = collectMetadata(repo("javascript"), dir);

    assert.equal(metadata.exclusionReason, undefined);
    assert.equal(metadata.languageSupport.diffciGraphCapable, true);
  });

  it("DOES exclude a repository whose only tsconfig.json is nested in a subdirectory, not at the root", () => {
    // Real finding, larger-study run 2026-08-20: fastify/fastify (and several other real corpus repos)
    // have a tsconfig.json nested in an examples/ or fixtures/ subdirectory but none at the repo root.
    // A first version of this check walked the whole repo tree and found the nested one, reporting
    // false capability - then every sampled commit failed anyway, because createProgram()'s
    // ts.findConfigFile() only ever starts at the repo root and walks UP, never down into
    // subdirectories. This must match that exact behavior, not a more permissive "anywhere in the tree"
    // search.
    mkdirSync(join(dir, "packages/core"), { recursive: true });
    writeFileSync(join(dir, "packages/core/tsconfig.json"), "{}\n");
    writeFileSync(join(dir, "packages/core/index.ts"), "export {};\n");

    const metadata = collectMetadata(repo("typescript"), dir);

    assert.match(metadata.exclusionReason ?? "", /no tsconfig\.json found/);
  });

  it("also excludes a non-TS/JS repository, with the exact language reason (not just tsconfig-less JS)", () => {
    // Same underlying failure mode as the tsconfig-less-JS case: createProgram() has no tsconfig.json
    // to build a ts.Program from regardless of language, so a Python/Go/Rust/Java repo would silently
    // fail every sampled commit the same way if this weren't excluded up front too.
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/main.py"), "def main(): pass\n");

    const metadata = collectMetadata(repo("python"), dir);

    assert.equal(metadata.languageSupport.diffciGraphCapable, false);
    assert.match(metadata.languageSupport.reason, /does not yet support python/);
    assert.match(metadata.exclusionReason ?? "", /does not yet support python/);
  });

  it("still excludes on the pre-existing size/file-count reasons even for a TS repo with a tsconfig.json", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "tsconfig.json"), "{}\n");
    for (let i = 0; i < 5001; i++) {
      writeFileSync(join(dir, `src/file${i}.ts`), "export {};\n");
    }

    const metadata = collectMetadata(repo("typescript"), dir);

    assert.match(metadata.exclusionReason ?? "", /source file count/);
  });
});

describe("isKnownUnsupportedLanguage", () => {
  it("is false only for typescript and javascript", () => {
    assert.equal(isKnownUnsupportedLanguage("typescript"), false);
    assert.equal(isKnownUnsupportedLanguage("javascript"), false);
    assert.equal(isKnownUnsupportedLanguage("python"), true);
    assert.equal(isKnownUnsupportedLanguage("go"), true);
    assert.equal(isKnownUnsupportedLanguage("rust"), true);
    assert.equal(isKnownUnsupportedLanguage("java"), true);
  });
});

describe("cloneOrUpdateRepo fast-path for known-unsupported languages", () => {
  // Real finding, larger-study run 2026-08-20: pallets/flask took 210 seconds and spf13/cobra took 42
  // seconds just to clone+walk before being excluded on language alone (the exclusion decision never
  // depended on anything the clone would reveal), and junit-team/junit5 (a large repo) timed out
  // entirely at 240s doing the same wasted work. This guards the fix: cloneOrUpdateRepo() must never
  // attempt a git clone at all for a repository whose primaryLanguage is already known-unsupported.
  it("excludes a Python repository WITHOUT cloning - no directory is created at the would-be clone path", () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "diffci-cache-"));
    try {
      const flask: ResearchRepository = { owner: "pallets", name: "flask", primaryLanguage: "python", framework: "web-framework", sizeClass: "medium" };
      const metadata = cloneOrUpdateRepo(flask, cacheDir, 300);

      assert.match(metadata.exclusionReason ?? "", /does not yet support python/);
      assert.equal(existsSync(repoLocalPath(cacheDir, flask)), false, "cloneOrUpdateRepo must not touch the filesystem for a known-unsupported language");
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("still attempts a real clone for a TypeScript repository (fast-path does not over-trigger)", () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "diffci-cache-"));
    try {
      // A nonexistent owner/repo, so the clone fails - proving a REAL clone attempt happened (and
      // failed for the expected git reason), not that it was silently skipped by the fast-path.
      const nope: ResearchRepository = { owner: "diffci-test-nonexistent-owner-xyz", name: "nonexistent-repo-xyz", primaryLanguage: "typescript", framework: "unknown", sizeClass: "small" };
      const metadata = cloneOrUpdateRepo(nope, cacheDir, 1);

      assert.match(metadata.exclusionReason ?? "", /clone failed/);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
