import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planPreflightChecks, matchesFilePattern } from "../../src/preflight/planner.js";
import type { PreflightCheckDefinition } from "../../src/preflight/checks-registry.js";

describe("matchesFilePattern", () => {
  it("matches an exact filename", () => {
    assert.ok(matchesFilePattern("package.json", "package.json"));
    assert.ok(matchesFilePattern("nested/dir/package.json", "package.json"));
  });
  it("matches a directory-prefix pattern", () => {
    assert.ok(matchesFilePattern(".github/workflows/ci.yml", ".github/workflows/"));
    assert.ok(!matchesFilePattern("src/.github/workflows-lookalike.ts", ".github/workflows/"));
  });
  it("matches a stem-substring pattern (e.g. every wrangler.*.jsonc)", () => {
    assert.ok(matchesFilePattern("wrangler.github-runner.jsonc", "wrangler."));
    assert.ok(matchesFilePattern("wrangler.synthetic-runner.jsonc", "wrangler."));
  });
  it("normalizes backslash path separators", () => {
    assert.ok(matchesFilePattern("nested\\dir\\package.json", "package.json"));
  });
  it("does not match unrelated files", () => {
    assert.ok(!matchesFilePattern("src/index.ts", "package.json"));
  });
});

describe("planPreflightChecks - Part C deterministic planner", () => {
  it("is deterministic: the same input always produces the exact same plan", () => {
    const files = ["src/preflight/planner.ts"];
    const a = planPreflightChecks(files);
    const b = planPreflightChecks(files);
    assert.deepEqual(a.checks.map((c) => c.check.id), b.checks.map((c) => c.check.id));
  });

  it("always-applicable checks run even for an unrelated single-file change", () => {
    const plan = planPreflightChecks(["src/preflight/planner.ts"]);
    const ids = plan.checks.map((c) => c.check.id);
    for (const alwaysOn of ["typecheck", "lint", "runtime_parity", "build", "affected_tests", "known_pattern_match"]) {
      assert.ok(ids.includes(alwaysOn), `${alwaysOn} should always be planned`);
    }
  });

  it("dependency_validation is only planned when a lockfile/manifest actually changed", () => {
    assert.ok(!planPreflightChecks(["src/index.ts"]).checks.some((c) => c.check.id === "dependency_validation"));
    assert.ok(planPreflightChecks(["package.json"]).checks.some((c) => c.check.id === "dependency_validation"));
    assert.ok(planPreflightChecks(["package-lock.json"]).checks.some((c) => c.check.id === "dependency_validation"));
  });

  it("config_validation is planned for a wrangler config or workflow change but not for an unrelated source file", () => {
    assert.ok(planPreflightChecks(["wrangler.github-runner.jsonc"]).checks.some((c) => c.check.id === "config_validation"));
    assert.ok(planPreflightChecks([".github/workflows/ci.yml"]).checks.some((c) => c.check.id === "config_validation"));
    assert.ok(!planPreflightChecks(["src/index.ts"]).checks.some((c) => c.check.id === "config_validation"));
  });

  it("real repo scenario: the actual Part A commit's changed files plan runtime_parity + config_validation but not dependency_validation", () => {
    // The real changed files from commit 8450e08 (this session's github-runner Sandbox rewrite).
    const files = ["src/research/cloudflare/github-runner-worker.ts", "src/runner/cloudflare/synthetic-runner-worker.ts", "wrangler.github-runner.jsonc", "wrangler.synthetic-runner.jsonc"];
    const plan = planPreflightChecks(files);
    const ids = plan.checks.map((c) => c.check.id);
    assert.ok(ids.includes("runtime_parity"));
    assert.ok(ids.includes("config_validation"));
    assert.ok(!ids.includes("dependency_validation"));
  });

  it("prerequisites are pulled in even when not independently applicable, and always precede their dependents", () => {
    const plan = planPreflightChecks(["src/index.ts"]);
    const order = plan.checks.map((c) => c.check.id);
    assert.ok(order.indexOf("typecheck") < order.indexOf("build"), "typecheck (build's prerequisite) must be scheduled before build");
    assert.ok(order.indexOf("typecheck") < order.indexOf("affected_tests"), "typecheck (affected_tests' prerequisite) must be scheduled before affected_tests");
  });

  it("a prerequisite pulled in only for a dependent is labeled prerequisite_of_applicable_check, not applicable", () => {
    // Construct a registry where a prerequisite is NOT itself always/changed-applicable, only pulled
    // in because a dependent needs it - isolates the "reason" labeling from the real registry's
    // current shape (which happens to make every prerequisite here always-applicable anyway).
    const registry: PreflightCheckDefinition[] = [
      { id: "base", name: "base", estimatedCostUnits: 1, estimatedDurationMs: 100, confidence: 0.9, prerequisites: [], failureClassesDetected: [], applicability: { trigger: "changed_files_match", filePatterns: ["never-matches-anything.xyz"] } },
      { id: "dependent", name: "dependent", estimatedCostUnits: 1, estimatedDurationMs: 100, confidence: 0.9, prerequisites: ["base"], failureClassesDetected: [], applicability: { trigger: "always" } },
    ];
    const plan = planPreflightChecks(["src/index.ts"], registry);
    const base = plan.checks.find((c) => c.check.id === "base")!;
    const dependent = plan.checks.find((c) => c.check.id === "dependent")!;
    assert.equal(base.reason, "prerequisite_of_applicable_check");
    assert.equal(dependent.reason, "applicable");
  });

  it("orders runnable checks by ascending estimatedCostUnits, tie-broken alphabetically by id", () => {
    const registry: PreflightCheckDefinition[] = [
      { id: "zeta_cheap", name: "z", estimatedCostUnits: 1, estimatedDurationMs: 1, confidence: 1, prerequisites: [], failureClassesDetected: [], applicability: { trigger: "always" } },
      { id: "alpha_cheap", name: "a", estimatedCostUnits: 1, estimatedDurationMs: 1, confidence: 1, prerequisites: [], failureClassesDetected: [], applicability: { trigger: "always" } },
      { id: "expensive", name: "e", estimatedCostUnits: 5, estimatedDurationMs: 1, confidence: 1, prerequisites: [], failureClassesDetected: [], applicability: { trigger: "always" } },
    ];
    const plan = planPreflightChecks([], registry);
    assert.deepEqual(plan.checks.map((c) => c.check.id), ["alpha_cheap", "zeta_cheap", "expensive"]);
  });

  it("throws on a prerequisite cycle rather than silently dropping or looping", () => {
    const registry: PreflightCheckDefinition[] = [
      { id: "a", name: "a", estimatedCostUnits: 1, estimatedDurationMs: 1, confidence: 1, prerequisites: ["b"], failureClassesDetected: [], applicability: { trigger: "always" } },
      { id: "b", name: "b", estimatedCostUnits: 1, estimatedDurationMs: 1, confidence: 1, prerequisites: ["a"], failureClassesDetected: [], applicability: { trigger: "always" } },
    ];
    assert.throws(() => planPreflightChecks([], registry), /cycle/);
  });

  it("throws on an unknown prerequisite id rather than silently ignoring it", () => {
    const registry: PreflightCheckDefinition[] = [
      { id: "a", name: "a", estimatedCostUnits: 1, estimatedDurationMs: 1, confidence: 1, prerequisites: ["does-not-exist"], failureClassesDetected: [], applicability: { trigger: "always" } },
    ];
    assert.throws(() => planPreflightChecks([], registry), /unknown check id/);
  });

  it("totals are the real sum of the selected checks' own cost/duration, never a separate estimate", () => {
    const plan = planPreflightChecks(["package.json"]);
    const expectedCost = plan.checks.reduce((s, c) => s + c.check.estimatedCostUnits, 0);
    const expectedDuration = plan.checks.reduce((s, c) => s + c.check.estimatedDurationMs, 0);
    assert.equal(plan.totalEstimatedCostUnits, expectedCost);
    assert.equal(plan.totalEstimatedDurationMs, expectedDuration);
  });
});
