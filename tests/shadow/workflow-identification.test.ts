/**
 * workflow-identification.ts (2026-09-05, seamless install): the evidence workflow and stage layout are
 * derived mechanically from the repository's own workflow files and package.json scripts. Fixtures are
 * the two real repositories whose configurations were written by hand on 2026-09-05 - the derivation
 * must reproduce them - plus the shapes that must be excluded.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyCommand,
  classifyStep,
  defaultStepName,
  identifyEvidenceWorkflow,
  resolveCommands,
  splitCommands,
  verifyDerivedShape,
} from "../../src/shadow/workflow-identification.js";

const DIFFCI_SCRIPTS = { typecheck: "tsc --noEmit", test: 'tsx --test "tests/**/*.test.ts"', check: "npm run typecheck && npm run test", "study:render": "tsx scripts/render-open-study.ts" };

const DIFFCI_CI_SPLIT = `name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  check:
    runs-on: [self-hosted, "diffci-job-\${{ github.run_id }}"]
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - name: Typecheck
        run: npm run typecheck
      - name: Test
        run: npm run test
`;

const DIFFCI_CI_LEGACY = `name: CI
on:
  push:
    branches: [main]
jobs:
  check:
    runs-on: [self-hosted, cloudflare]
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run check
`;

const DIFFCI_OBSERVE = `name: DiffCI observation
on:
  push:
    branches: [main]
jobs:
  observe:
    name: Observe this repository
    runs-on: [self-hosted, cloudflare]
    steps:
      - uses: ./
`;

const CODEQL = `name: CodeQL
on:
  push:
    branches: [main]
  pull_request:
  schedule:
    - cron: "0 0 * * 1"
jobs:
  analyze:
    name: Analyze (\${{ matrix.language }})
    runs-on: ubuntu-latest
    steps:
      - uses: github/codeql-action/analyze@v3
`;

const DP_SCRIPTS = {
  typecheck: "tsc --noEmit --pretty false",
  lint: 'eslint "src/**/*.{ts,tsx}"',
  test: "node --test ops/cloudflare/src/a.test.mjs && tsx --conditions react-server --test \"src/**/*.test.ts\"",
  check: "npm run typecheck && npm run lint && npm run check:links",
  "check:links": "node scripts/check-links.js",
  "validate:aws": "node scripts/validate-aws.js",
};

const DP_DEPLOY = `name: Deploy Cloudflare staging
on:
  push:
    branches: [main]
jobs:
  check:
    name: Typecheck, lint, and portability
    runs-on: ubuntu-latest
    steps:
      - name: Check out commit
        uses: actions/checkout@v4
      - name: Install dependencies
        run: npm ci --no-audit --no-fund
      - name: Run checks
        run: npm run check
      - name: Validate AWS and Google-service boundaries
        run: npm run validate:aws
  deploy:
    name: Build and deploy exact commit to Cloudflare
    needs: check
    runs-on: ubuntu-latest
    steps:
      - name: Check out triggering commit
        uses: actions/checkout@v4
      - name: Install and test
        run: |
          npm ci --no-audit --no-fund
          npm test
      - name: Deploy Cloudflare staging
        run: npm run deploy:cloudflare:ci -- staging
`;

const NOW = "2026-09-05T09:00:00.000Z";

describe("command resolution and classification", () => {
  it("splits shell and resolves npm scripts recursively, including pre/post hooks", () => {
    assert.deepEqual(splitCommands("npm ci --no-audit\nnpm test && echo done; npm run lint"), ["npm ci --no-audit", "npm test", "echo done", "npm run lint"]);
    assert.deepEqual(resolveCommands(["npm run check"], DIFFCI_SCRIPTS), ["tsc --noEmit", 'tsx --test "tests/**/*.test.ts"']);
    assert.deepEqual(resolveCommands(["npm test"], { pretest: "npm run build", test: "vitest run", build: "tsup" }), ["tsup", "vitest run"]);
    assert.deepEqual(resolveCommands(["pnpm test"], { test: "vitest run --coverage" }), ["vitest run --coverage"]);
    assert.deepEqual(resolveCommands(["yarn lint"], { lint: "eslint ." }), ["eslint ."]);
    assert.deepEqual(resolveCommands(["npm run loop"], { loop: "npm run loop" }), ["npm run loop"], "cycles terminate");
    assert.deepEqual(resolveCommands(["npm run missing"], DIFFCI_SCRIPTS), ["npm run missing"], "an unknown script is kept verbatim, never guessed");
  });

  it("classifies commands by what they execute, not by what they are called", () => {
    assert.equal(classifyCommand('tsx --test "tests/**/*.test.ts"'), "test");
    assert.equal(classifyCommand("node --test ops/a.test.mjs"), "test");
    assert.equal(classifyCommand("vitest run"), "test");
    assert.equal(classifyCommand("playwright test"), "e2e");
    assert.equal(classifyCommand("tsc --noEmit"), "typecheck");
    assert.equal(classifyCommand('eslint "src/**/*.ts"'), "lint");
    assert.equal(classifyCommand("next build"), "build");
    assert.equal(classifyCommand("npm ci --no-audit"), "install");
    assert.equal(classifyCommand("node scripts/check-links.js"), undefined);
    assert.equal(classifyCommand("npm run deploy:cloudflare:ci -- staging"), undefined, "an unresolved script name proves nothing");
    assert.equal(classifyCommand("pnpm --filter nuxt test:size"), undefined, "a task merely named test:* is not a test runner (bundle-size checks, type tests)");
    assert.equal(classifyCommand("turbo run test"), "test");
    assert.equal(classifyCommand("node scripts/check-typecheck-results.js"), undefined, "the word typecheck in a path is not tsc");
  });

  it("a step spanning stages, or bundling an install with tests, is inseparable", () => {
    assert.deepEqual(classifyStep(["tsc --noEmit", 'tsx --test "x"']), { stages: ["test", "typecheck"], stage: "test", inseparable: true });
    assert.deepEqual(classifyStep(["npm ci --no-audit --no-fund", "node --test a.mjs"]), { stages: ["test"], stage: "test", inseparable: true });
    assert.deepEqual(classifyStep(['tsx --test "x"']), { stages: ["test"], stage: "test", inseparable: false });
    assert.deepEqual(classifyStep(["echo hi"]), { stages: [], inseparable: false });
  });

  it("predicts GitHub's default step names", () => {
    assert.equal(defaultStepName({ run: "npm ci" }), "Run npm ci");
    assert.equal(defaultStepName({ run: "npm ci --no-audit\nnpm test" }), "Run npm ci --no-audit");
    assert.equal(defaultStepName({ uses: "actions/checkout@v4" }), "Run actions/checkout@v4");
    assert.equal(defaultStepName({ name: " Test ", run: "npm test" }), "Test");
  });
});

describe("identifyEvidenceWorkflow", () => {
  it("DiffCI.com: picks ci.yml over the observation workflow and CodeQL, and derives separable Typecheck/Test step rules", () => {
    const r = identifyEvidenceWorkflow({
      workflows: [
        { path: ".github/workflows/ci.yml", content: DIFFCI_CI_SPLIT },
        { path: ".github/workflows/diffci-observe.yml", content: DIFFCI_OBSERVE },
        { path: ".github/workflows/codeql.yml", content: CODEQL },
      ],
      packageScripts: DIFFCI_SCRIPTS,
      defaultBranch: "main",
    }, NOW);
    assert.equal(r.status, "IDENTIFIED");
    if (r.status !== "IDENTIFIED") return;
    assert.deepEqual(r.evidenceWorkflowPaths, [".github/workflows/ci.yml"]);
    assert.deepEqual(r.stageClassification.steps, [
      { job: "check", step: "Typecheck", stage: "typecheck" },
      { job: "check", step: "Test", stage: "test" },
    ]);
    assert.deepEqual(r.stageClassification.jobs, [{ job: "check", stage: "other" }]);
    assert.equal(r.derivation.chosen?.path, ".github/workflows/ci.yml");
    const excluded = Object.fromEntries(r.derivation.candidates.map((c) => [c.path, c.excludedReason]));
    assert.equal(excluded[".github/workflows/diffci-observe.yml"], "DiffCI's own observation workflow");
    assert.equal(excluded[".github/workflows/codeql.yml"], "no step runs a test command");
    assert.deepEqual(r.derivation.alsoRunTests, []);
  });

  it("DiffCI.com before the step split: the single `npm run check` step resolves to typecheck+test and is test/inseparable - the hand-written rule", () => {
    const r = identifyEvidenceWorkflow({ workflows: [{ path: ".github/workflows/ci.yml", content: DIFFCI_CI_LEGACY }], packageScripts: DIFFCI_SCRIPTS, defaultBranch: "main" }, NOW);
    assert.equal(r.status, "IDENTIFIED");
    if (r.status !== "IDENTIFIED") return;
    assert.deepEqual(r.stageClassification.steps, [{ job: "check", step: "Run npm run check", stage: "test", inseparable: true }]);
  });

  it("DentalPresence.in: picks the deploy workflow, test step inseparable (npm ci in the same step), checks step typecheck/inseparable - the hand-written configuration", () => {
    const r = identifyEvidenceWorkflow({
      workflows: [{ path: ".github/workflows/cloudflare-staging-deploy.yml", content: DP_DEPLOY }, { path: ".github/workflows/codeql.yml", content: CODEQL }],
      packageScripts: DP_SCRIPTS,
      defaultBranch: "main",
    }, NOW);
    assert.equal(r.status, "IDENTIFIED");
    if (r.status !== "IDENTIFIED") return;
    assert.deepEqual(r.evidenceWorkflowPaths, [".github/workflows/cloudflare-staging-deploy.yml"]);
    const steps = r.stageClassification.steps;
    assert.deepEqual(steps.find((s) => s.step === "Install and test"), { job: "Build and deploy exact commit to Cloudflare", step: "Install and test", stage: "test", inseparable: true });
    assert.deepEqual(steps.find((s) => s.step === "Run checks"), { job: "Typecheck, lint, and portability", step: "Run checks", stage: "typecheck", inseparable: true });
    assert.equal(steps.find((s) => s.step === "Deploy Cloudflare staging"), undefined, "an unresolvable deploy command gets no stage rule");
    assert.deepEqual(r.stageClassification.jobs.map((j) => j.job), ["Typecheck, lint, and portability", "Build and deploy exact commit to Cloudflare"]);
  });

  it("prefers the workflow that runs tests on push to the default branch over a pull_request-only one, and records the runner-up", () => {
    const prOnly = `on: pull_request\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: vitest run\n`;
    const pushMain = `on:\n  push:\n    branches: [main]\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: vitest run\n`;
    const r = identifyEvidenceWorkflow({ workflows: [{ path: ".github/workflows/pr.yml", content: prOnly }, { path: ".github/workflows/main.yml", content: pushMain }], defaultBranch: "main" }, NOW);
    assert.equal(r.status, "IDENTIFIED");
    if (r.status !== "IDENTIFIED") return;
    assert.deepEqual(r.evidenceWorkflowPaths, [".github/workflows/main.yml"]);
    assert.deepEqual(r.derivation.alsoRunTests, [".github/workflows/pr.yml"]);
  });

  it("a push workflow whose branches exclude the default branch does not score as default-branch evidence", () => {
    const releaseOnly = `on:\n  push:\n    branches: [release/*]\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: vitest run\n`;
    const r = identifyEvidenceWorkflow({ workflows: [{ path: ".github/workflows/rel.yml", content: releaseOnly }], defaultBranch: "main" }, NOW);
    assert.equal(r.status, "IDENTIFIED");
    if (r.status !== "IDENTIFIED") return;
    assert.equal(r.derivation.candidates[0]!.triggers.pushDefaultBranch, false);
  });

  it("NONE_FOUND names every workflow and why: no workflows, only scheduled, only lint, or unparseable", () => {
    const none = identifyEvidenceWorkflow({ workflows: [], defaultBranch: "main" }, NOW);
    assert.equal(none.status, "NONE_FOUND");
    const sched = `on:\n  schedule:\n    - cron: "0 0 * * *"\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: vitest run\n`;
    const lintOnly = `on: [push]\njobs:\n  l:\n    runs-on: ubuntu-latest\n    steps:\n      - run: eslint .\n`;
    const r = identifyEvidenceWorkflow({ workflows: [{ path: ".github/workflows/nightly.yml", content: sched }, { path: ".github/workflows/lint.yml", content: lintOnly }, { path: ".github/workflows/bad.yml", content: "on: [\n" }], defaultBranch: "main" }, NOW);
    assert.equal(r.status, "NONE_FOUND");
    if (r.status !== "NONE_FOUND") return;
    assert.ok(r.reason.includes("nightly.yml: not triggered by push or pull_request"));
    assert.ok(r.reason.includes("lint.yml: no step runs a test command"));
    assert.ok(r.reason.includes("bad.yml: unparseable YAML"));
  });
});

describe("verifyDerivedShape", () => {
  const config = { version: 1 as const, jobs: [{ job: "check", stage: "other" as const }], steps: [{ job: "check", step: "Test", stage: "test" as const }] };
  it("verifies when the derived test step executed in the run", () => {
    const v = verifyDerivedShape(config, [{ jobName: "check", steps: [{ name: "Run npm ci" }, { name: "Test" }] }]);
    assert.deepEqual([v.ok, v.verified], [true, true]);
  });
  it("fails when no derived job exists in the run, or an executed job lacks a derived step", () => {
    assert.equal(verifyDerivedShape(config, [{ jobName: "build", steps: [{ name: "x" }] }]).ok, false);
    assert.equal(verifyDerivedShape(config, [{ jobName: "check", steps: [{ name: "Run npm run check" }] }]).ok, false);
  });
  it("a derived job that was skipped in this run (no steps) neither confirms nor contradicts - nuxt/nuxt on a docs-only commit", () => {
    const v = verifyDerivedShape(config, [{ jobName: "check", steps: [] }, { jobName: "docs", steps: [{ name: "Build docs" }] }]);
    assert.deepEqual([v.ok, v.verified], [true, false]);
    const w = verifyDerivedShape(config, [{ jobName: "check" }]);
    assert.deepEqual([w.ok, w.verified], [true, false]);
  });
});

describe("corpus shapes found live on 2026-09-05", () => {
  it("unjs/nitro: test steps nested under a `parallel:` group are seen; pnpm vitest resolves to a test step", () => {
    const nitro = `name: ci
on:
  push:
    branches: [main]
  pull_request:
jobs:
  tests-checks:
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest]
    steps:
      - uses: actions/checkout@v4
      - run: pnpm install
      - run: pnpm build
      - parallel:
          - run: pnpm typecheck
          - run: pnpm vitest run test/unit
          - run: pnpm vitest run test/minimal
`;
    const r = identifyEvidenceWorkflow({ workflows: [{ path: ".github/workflows/ci.yml", content: nitro }], packageScripts: { typecheck: "tsc --noEmit", build: "obuild" }, defaultBranch: "main" }, NOW);
    assert.equal(r.status, "IDENTIFIED");
    if (r.status !== "IDENTIFIED") return;
    const steps = r.stageClassification.steps;
    assert.deepEqual(steps.filter((s) => s.stage === "test").map((s) => s.step), ["Run pnpm vitest run test/unit", "Run pnpm vitest run test/minimal"]);
    assert.deepEqual(steps.find((s) => s.step === "Run pnpm typecheck"), { job: "tests-checks", step: "Run pnpm typecheck", stage: "typecheck" });
  });

  it("withastro/astro: `turbo run test` and a matrix-provided test script both count as test steps", () => {
    const astro = `name: CI
on:
  push:
    branches: [main]
jobs:
  test:
    name: "Test (\${{ matrix.TEST_SUITE.name }}): \${{ matrix.os }}"
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest]
        TEST_SUITE:
          - name: astro
            script: pnpm run test:citgm
          - name: playwright
            script: pnpm run test:e2e
    steps:
      - run: pnpm install
      - name: Build Packages
        run: turbo run build --filter=astro
      - name: Test \${{ matrix.TEST_SUITE.name }}
        run: \${{ matrix.TEST_SUITE.script }}
  language:
    name: Test (language-tools)
    runs-on: ubuntu-latest
    steps:
      - name: Test
        run: node ./scripts/turbo-run-affected.js test --filter=astro
      - name: Test (Linux)
        run: turbo run test --filter="@astrojs/language-server"
`;
    const r = identifyEvidenceWorkflow({ workflows: [{ path: ".github/workflows/ci.yml", content: astro }], packageScripts: { "test:citgm": "pnpm run build && vitest run --coverage", "test:e2e": "playwright test" }, defaultBranch: "main" }, NOW);
    assert.equal(r.status, "IDENTIFIED");
    if (r.status !== "IDENTIFIED") return;
    const steps = r.stageClassification.steps;
    const matrixStep = steps.find((s) => s.step === "Test ${{ matrix.TEST_SUITE.name }}");
    assert.ok(matrixStep, "the matrix step was expanded through both suites");
    assert.equal(matrixStep!.stage, "test");
    assert.equal(matrixStep!.inseparable, true, "one suite builds then tests, the other is e2e - mixed, so inseparable");
    assert.equal(steps.find((s) => s.step === "Test (Linux)")?.stage, "test", "turbo run test executes the packages' test scripts");
    assert.equal(steps.find((s) => s.step === "Build Packages")?.stage, "build");
  });
});
