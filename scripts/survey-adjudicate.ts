/**
 * Addressability survey: ADJUDICATION.
 *
 * A pure function from recorded facts to exactly one outcome. It fetches nothing and clones nothing, so
 * every classification can be re-derived offline from committed evidence, and a disputed verdict can be
 * re-examined without the world having moved underneath it.
 *
 * The gates and their ORDER are frozen at `af3b355`
 * (docs/addressability-survey-preregistration.md). The first gate a repository fails is its outcome.
 * That ordering is what makes the categories mutually exclusive - without it a difficult repository
 * accumulates several reasons and the percentages stop meaning anything.
 *
 * Gates 5 and 6 are NOT decided here. They require executing the suite in the canonical container, and
 * this module only reports that a repository reached them.
 */
import { parseTestFileCount, parseTestOutput } from "./test-output-parsers.js";
import type { RepositoryFacts } from "./survey-facts.js";

export type SurveyOutcome =
  | "EXCLUDED_ALREADY_EXAMINED"
  | "EXCLUDED_NO_REPOSITORY"
  | "EXCLUDED_ARCHIVED"
  | "EXCLUDED_NO_TESTS"
  | "EXCLUDED_NOT_JS_TS"
  | "MONOREPO_SCOPE_UNSUPPORTED"
  | "RUNNER_UNSUPPORTED"
  | "NO_ROOT_COMMAND"
  | "SELECTION_SURFACE_UNADDRESSABLE"
  | "REACHED_QUALIFICATION"
  | "SURVEY_ERROR";

export interface Adjudication {
  rank: number;
  packageName: string;
  repository: string | null;
  outcome: SurveyOutcome;
  /** Which gate decided it: 0 for an exclusion, 1-4 for a structural gate, 5 when it reached the container. */
  gate: number;
  /** The specific fact that decided it, quoted rather than summarised. */
  reason: string;
}

/**
 * Repositories this project has already examined, excluded under pre-registered rule 1.
 *
 * Frozen list. Their earlier outcomes are external-validation evidence and are NOT survey observations:
 * they were selected one at a time by a human who knew the preceding results, which is a different
 * mechanism entirely.
 */
export const ALREADY_EXAMINED = new Set([
  "honojs/hono", "colinhacks/zod", "vuejs/core", "TanStack/query",
  "fastify/fastify", "date-fns/date-fns", "chalk/chalk", "axios/axios", "immerjs/immer",
]);

/**
 * Which runners this harness can actually read, MEASURED rather than asserted.
 *
 * Each entry is a real summary line from that runner. Both parsers are run against it at adjudication
 * time, so the capability recorded in the survey is the apparatus's genuine behaviour at `af3b355` - if
 * a parser changes, this table's answers change with it rather than going quietly stale.
 *
 * Gate 2 requires BOTH a failure count and a test-FILE count. They are different limits: mocha and
 * node:test yield a failure count and no file count, which is precisely why the pre-registration split
 * gate 2 from gate 6.
 */
const RUNNER_PROBES: { runner: string; packages: string[]; sample: string }[] = [
  { runner: "vitest", packages: ["vitest"], sample: " Test Files  3 passed (3)\n      Tests  10 passed (10)\n" },
  { runner: "jest", packages: ["jest", "ts-jest", "jest-cli", "babel-jest"], sample: "Test Suites: 3 passed, 3 total\nTests:       10 passed, 10 total\n" },
  { runner: "mocha", packages: ["mocha"], sample: "  10 passing (20ms)\n" },
  { runner: "node:test", packages: ["borp", "glob-tap", "tsx"], sample: "ℹ tests 10\nℹ fail 0\n" },
  { runner: "ava", packages: ["ava"], sample: "  3 tests passed\n" },
  { runner: "tap", packages: ["tap", "libtap"], sample: "# pass 10\n# fail 0\n" },
  { runner: "jasmine", packages: ["jasmine", "jasmine-core"], sample: "10 specs, 0 failures\n" },
  { runner: "karma", packages: ["karma"], sample: "Executed 10 of 10 SUCCESS\n" },
  { runner: "uvu", packages: ["uvu"], sample: "  Total:     10\n  Passed:    10\n" },
  { runner: "playwright", packages: ["@playwright/test"], sample: "  10 passed (2s)\n" },
];

export interface RunnerCapability {
  runner: string;
  failureCountReadable: boolean;
  fileCountReadable: boolean;
  /** Both, which is what gate 2 requires. */
  supported: boolean;
}

/** Runs every probe through the real parsers. Called at adjudication time, never hard-coded. */
export function measureRunnerCapabilities(): RunnerCapability[] {
  return RUNNER_PROBES.map(({ runner, sample }) => {
    const failureCountReadable = parseTestOutput(sample).failures !== undefined;
    const fileCountReadable = parseTestFileCount(sample) !== undefined;
    return { runner, failureCountReadable, fileCountReadable, supported: failureCountReadable && fileCountReadable };
  });
}

/** Which runners a repository declares, from its dependencies and config files. A fact, not a verdict. */
export function declaredRunners(facts: RepositoryFacts): string[] {
  const declared = new Set<string>();
  const deps = new Set([...(facts.packageJson?.devDependencyNames ?? []), ...(facts.packageJson?.dependencyNames ?? [])]);
  for (const { runner, packages } of RUNNER_PROBES) {
    if (packages.some((p) => deps.has(p))) declared.add(runner);
  }
  // Config files carry the same information for repositories that rely on a globally installed runner.
  for (const config of facts.files.runnerConfigs) {
    if (config.startsWith("vitest.config")) declared.add("vitest");
    else if (config.startsWith("jest.config")) declared.add("jest");
    else if (config.startsWith(".mocharc")) declared.add("mocha");
    else if (config.startsWith(".borp")) declared.add("node:test");
    else if (config.startsWith("ava.config")) declared.add("ava");
    else if (config.startsWith("karma.conf")) declared.add("karma");
    else if (config.startsWith("playwright.config")) declared.add("playwright");
    else if (config === "tap.yaml" || config === ".taprc") declared.add("tap");
  }
  // A runner named directly in the test script, for repositories that declare it nowhere else.
  const scripts = Object.values(facts.packageJson?.scripts ?? {}).join(" ; ");
  for (const { runner, packages } of RUNNER_PROBES) {
    const token = packages[0]!.replace(/^@[^/]+\//, "");
    if (new RegExp(`(^|[\\s;&|"'])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$|["'])`).test(scripts)) declared.add(runner);
  }
  return [...declared].sort();
}

/** Test scripts the repository itself documents, in the order package.json lists them. */
export function testScripts(facts: RepositoryFacts): { name: string; command: string }[] {
  return Object.entries(facts.packageJson?.scripts ?? {})
    .filter(([name]) => name === "test" || name.startsWith("test:") || name === "unit" || name === "test-unit")
    .map(([name, command]) => ({ name, command }));
}

/** Things a root command cannot depend on under the validation contract. */
const FORBIDDEN_IN_ROOT_COMMAND = [
  { token: "playwright", why: "requires a browser" },
  { token: "--browser", why: "requires a browser" },
  { token: "karma", why: "requires a browser" },
  { token: "puppeteer", why: "requires a browser" },
  { token: "cypress", why: "requires a browser" },
  { token: "deno ", why: "requires a foreign runtime" },
  { token: "bun ", why: "requires a foreign runtime" },
  { token: "docker", why: "requires a service" },
  { token: "docker-compose", why: "requires a service" },
];

export function adjudicate(facts: RepositoryFacts): Adjudication {
  const base = { rank: facts.rank, packageName: facts.packageName, repository: facts.repository };
  const decide = (outcome: SurveyOutcome, gate: number, reason: string): Adjudication => ({ ...base, outcome, gate, reason });

  // ---- Pre-registered exclusions. Gate 0: outside the survey, reported separately from the denominator.
  if (!facts.registry.resolved) return decide("SURVEY_ERROR", 0, `npm registry lookup failed: ${facts.registry.error ?? "unknown"}`);
  if (!facts.repository) return decide("EXCLUDED_NO_REPOSITORY", 0, `registry names no GitHub repository (repository.url = ${facts.registry.repositoryUrl ?? "absent"})`);
  if (ALREADY_EXAMINED.has(facts.repository)) return decide("EXCLUDED_ALREADY_EXAMINED", 0, `${facts.repository} was examined by this project before the survey`);
  if (facts.github.archived === true) return decide("EXCLUDED_ARCHIVED", 0, `GitHub reports the repository archived`);
  if (!facts.clone.ok) return decide("SURVEY_ERROR", 0, `clone failed: ${facts.clone.error ?? "unknown"}`);

  const totalTestFiles = Object.values(facts.testSurface.patternCounts).reduce((a, b) => Math.max(a, b), 0);
  const scripts = testScripts(facts);
  if (scripts.length === 0 && totalTestFiles === 0) {
    return decide("EXCLUDED_NO_TESTS", 0, "no test script in package.json and no files matching any test pattern");
  }

  const ext = facts.testSurface.extensionCounts;
  const jsts = (ext.js ?? 0) + (ext.ts ?? 0) + (ext.jsx ?? 0) + (ext.tsx ?? 0) + (ext.mjs ?? 0) + (ext.cjs ?? 0) + (ext.mts ?? 0) + (ext.cts ?? 0);
  const allCounted = Object.values(ext).reduce((a, b) => a + b, 0);
  if (allCounted > 0 && jsts / allCounted < 0.2) {
    return decide("EXCLUDED_NOT_JS_TS", 0, `JS/TS files are ${((jsts / allCounted) * 100).toFixed(0)}% of counted files`);
  }

  // ---- Gate 1: single execution scope.
  const hasWorkspaces = facts.packageJson?.workspaces !== undefined && facts.packageJson.workspaces !== null;
  const workspaceConfigs = facts.files.workspaceConfigs;
  if (hasWorkspaces || workspaceConfigs.length > 0) {
    const evidence = [hasWorkspaces ? "package.json declares workspaces" : null, ...workspaceConfigs].filter(Boolean).join(", ");
    return decide("MONOREPO_SCOPE_UNSUPPORTED", 1, `monorepo: ${evidence}. The harness runs the test module with cwd at the clone root and has no test working directory.`);
  }

  // ---- Gate 2: runner readable, BOTH a failure count and a test-file count.
  const capabilities = new Map(measureRunnerCapabilities().map((c) => [c.runner, c]));
  const declared = declaredRunners(facts);
  if (declared.length === 0) {
    return decide("RUNNER_UNSUPPORTED", 2, "no runner could be identified from dependencies, config files, or test scripts");
  }
  const supported = declared.filter((r) => capabilities.get(r)?.supported === true);
  if (supported.length === 0) {
    const detail = declared
      .map((r) => {
        const c = capabilities.get(r);
        return `${r} (failure count ${c?.failureCountReadable ? "readable" : "unreadable"}, file count ${c?.fileCountReadable ? "readable" : "unreadable"})`;
      })
      .join("; ");
    return decide("RUNNER_UNSUPPORTED", 2, `declares ${detail}`);
  }

  // ---- Gate 3: a documented root command that needs no browser, foreign runtime, or service.
  const usable = scripts.filter((s) => {
    const lower = s.command.toLowerCase();
    if (FORBIDDEN_IN_ROOT_COMMAND.some((f) => lower.includes(f.token))) return false;
    return supported.some((r) => lower.includes(r === "node:test" ? "borp" : r));
  });
  if (usable.length === 0) {
    if (scripts.length === 0) return decide("NO_ROOT_COMMAND", 3, "no test script in package.json");
    const detail = scripts.map((s) => `${s.name}: ${s.command}`).join(" | ").slice(0, 400);
    return decide("NO_ROOT_COMMAND", 3, `no documented script runs a supported runner without a browser, foreign runtime, or service. Scripts: ${detail}`);
  }

  // ---- Gate 4: explicit-file addressability.
  // vitest and jest both accept positional file filters and run exactly the matching files; this was
  // verified directly against axios and immer before the survey. A repository reaching here with one of
  // those runners passes on the runner's documented behaviour, and the container run that follows would
  // expose it if that were wrong.
  if (totalTestFiles === 0) {
    return decide("SELECTION_SURFACE_UNADDRESSABLE", 4, "a supported runner and a root command, but no files match any known test pattern, so there is nothing to address by name");
  }

  return decide(
    "REACHED_QUALIFICATION",
    5,
    `runner ${supported.join("/")}, script "${usable[0]!.name}: ${usable[0]!.command}", ${totalTestFiles} test files by best-matching pattern`,
  );
}
