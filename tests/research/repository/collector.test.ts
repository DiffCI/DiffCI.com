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

    assert.match(metadata.exclusionReason ?? "", /no tsconfig\.json anywhere/);
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

  it("does NOT exclude a monorepo whose tsconfigs are per-package, and says so in the reason", () => {
    // INVERTED 2026-08-26 (Phase 01 F3). This asserted the opposite, on the grounds that
    // createProgram()'s ts.findConfigFile() "only ever starts at the repo root and walks UP, never
    // down into subdirectories". That was true when written and stopped being true on 2026-08-24,
    // when graph.ts gained nested per-package tsconfig discovery for biome and cal.diy. The gate was
    // never updated, so it went on refusing repositories the engine could analyse: vitest-dev/vitest
    // and facebook/docusaurus were both excluded as "cannot analyze" and then built 2118- and
    // 1131-node graphs. Refusing vitest cost roughly 144 container launches a day, because the
    // refusal is raised after the clone.
    //
    // The gate now delegates to classifyTypeScriptProject() rather than restating a rule beside the
    // graph builder, so this class of drift cannot recur silently.
    mkdirSync(join(dir, "packages/core"), { recursive: true });
    writeFileSync(join(dir, "packages/core/tsconfig.json"), "{}\n");
    writeFileSync(join(dir, "packages/core/index.ts"), "export {};\n");

    const metadata = collectMetadata(repo("typescript"), dir);

    assert.equal(metadata.exclusionReason, undefined);
    assert.equal(metadata.languageSupport.diffciGraphCapable, true);
    assert.match(metadata.languageSupport.reason, /per-package tsconfig/);
    assert.match(metadata.languageSupport.reason, /PARTIAL/, "the confidence cap must be stated, not implied");
  });

  it("admits the fastify shape - only an examples/ tsconfig - and relies on confidence to contain it", () => {
    // The original reason for the root-only rule: fastify/fastify has a tsconfig.json nested under
    // examples/ or fixtures/ and none at the root, so "capable" would be answered by a project that
    // describes example code rather than the library. That imprecision is real and is NOT claimed to
    // be solved here - the gate is a cheap structural check, not an analysis.
    //
    // What contains it is downstream and load-bearing: a changed source file absent from the graph
    // classifies as UNKNOWN_FILE and forces FULL, and a repository declaring a test framework with no
    // discoverable tests is a blind spot that also forces FULL (Phase 01 F1). The failure mode is a
    // conservative fallback, not a confident wrong selection - which is the trade this gate should be
    // making, given the alternative is refusing every genuine monorepo.
    mkdirSync(join(dir, "examples"), { recursive: true });
    writeFileSync(join(dir, "examples/tsconfig.json"), "{}\n");
    writeFileSync(join(dir, "examples/demo.ts"), "export {};\n");
    mkdirSync(join(dir, "lib"), { recursive: true });
    writeFileSync(join(dir, "lib/index.js"), "module.exports = {};\n");

    const metadata = collectMetadata(repo("javascript"), dir);

    assert.equal(metadata.exclusionReason, undefined);
    assert.equal(metadata.languageSupport.diffciGraphCapable, true);
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
