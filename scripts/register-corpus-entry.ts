/**
 * Register a repository in the corpus registry, mechanically.
 *
 * `dogfood:qualify` only qualifies repositories the registry knows. The frame-continuation repositories
 * are not in it, which is why `e2-01-lint-staged` failed with "the collected corpus has no entry" —
 * an APPARATUS GAP, not a red suite.
 *
 * Registration needs an install command, an optional build, and a runner entry point, and choosing
 * those per repository is where bias enters: a repository can be made green by picking friendlier
 * commands. So this derives all of them from the repository's OWN manifest under the rule frozen in
 * `docs/e2-registration-rule.md`, and REFUSES when the rule cannot decide.
 *
 * It never executes the repository. It reads `package.json` and looks for lockfiles. Qualification runs
 * separately and is the only thing that executes anything.
 *
 * Usage:
 *   npm run corpus:register -- --repo <clone> --source owner/name [--out <corpus.json>]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface CorpusEntry {
  source: string;
  stresses: string;
  commits: number;
  observationQualified: string;
  mutationQualified: string;
  install?: string[];
  build?: string[];
  testModule?: string;
  testArgs?: string[];
  registrationRule?: string;
}

function flag(args: string[], key: string): string | undefined {
  const i = args.indexOf(`--${key}`);
  return i !== -1 ? args[i + 1] : undefined;
}

/** Package manager from the lockfile actually committed. Never inferred from anything else. */
function installFor(repoPath: string): { install: string[]; manager: "pnpm" | "yarn" | "npm" } {
  if (existsSync(join(repoPath, "pnpm-lock.yaml"))) return { install: ["corepack", "pnpm", "install", "--frozen-lockfile"], manager: "pnpm" };
  if (existsSync(join(repoPath, "yarn.lock"))) return { install: ["corepack", "yarn", "install", "--immutable"], manager: "yarn" };
  if (existsSync(join(repoPath, "package-lock.json"))) return { install: ["npm", "ci", "--no-audit", "--no-fund"], manager: "npm" };
  return { install: ["npm", "install", "--no-audit", "--no-fund"], manager: "npm" };
}

/**
 * Runner entry point from the DECLARED dev dependency.
 *
 * Returns undefined rather than defaulting. A repository silently defaulted to vitest would be recorded
 * RED for a reason that is about this script, not about the repository.
 */
function runnerFor(pkg: Record<string, any>): { testModule: string; testArgs: string[] } | undefined {
  const dev = { ...(pkg.devDependencies ?? {}), ...(pkg.dependencies ?? {}) } as Record<string, string>;
  if (dev.vitest) return { testModule: "node_modules/vitest/vitest.mjs", testArgs: ["run"] };
  if (dev.jest) return { testModule: "node_modules/jest/bin/jest.js", testArgs: [] };
  return undefined;
}

function main(): void {
  const args = process.argv.slice(2);
  const repoPath = resolve(flag(args, "repo") ?? "");
  const source = flag(args, "source");
  const outPath = resolve(flag(args, "out") ?? "scripts/dogfood-corpus.json");
  if (!flag(args, "repo") || !source) throw new Error("--repo <clone> and --source owner/name are required");

  const pkgPath = join(repoPath, "package.json");
  if (!existsSync(pkgPath)) {
    console.log(`UNREGISTERABLE ${source}: no package.json at the pinned tree`);
    process.exit(2);
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, any>;
  const runner = runnerFor(pkg);
  if (!runner) {
    // Refuses rather than guessing. See the frozen rule.
    console.log(`UNREGISTERABLE ${source}: neither vitest nor jest is a declared dependency, so the runner is undeterminable`);
    process.exit(2);
  }
  const { install, manager } = installFor(repoPath);
  const hasBuild = typeof pkg.scripts?.build === "string";
  // Uniformly included when a build script exists. Omitting it produced the J1 defect, where a
  // registration mistake was nearly recorded as a qualification failure.
  const build = hasBuild ? (manager === "npm" ? ["npm", "run", "build"] : ["corepack", manager, "run", "build"]) : undefined;

  const corpus = JSON.parse(readFileSync(outPath, "utf8")) as CorpusEntry[];
  if (corpus.some((e) => e.source === source)) {
    console.log(`ALREADY REGISTERED ${source} - not overwritten`);
    return;
  }

  const entry: CorpusEntry = {
    source,
    stresses: `Frame continuation (npm-high-impact@1.13.0 topDependent). Registered mechanically under docs/e2-registration-rule.md; commands derived from the repository's own manifest, never chosen per repository.`,
    commits: 0,
    observationQualified: "unknown",
    mutationQualified: "unknown",
    install,
    ...(build ? { build } : {}),
    testModule: runner.testModule,
    testArgs: runner.testArgs,
    registrationRule: "docs/e2-registration-rule.md",
  };
  corpus.push(entry);
  writeFileSync(outPath, `${JSON.stringify(corpus, null, 2)}\n`);

  console.log(`REGISTERED ${source}`);
  console.log(`  install     ${install.join(" ")}`);
  console.log(`  build       ${build ? build.join(" ") : "(none - no build script)"}`);
  console.log(`  testModule  ${runner.testModule} ${runner.testArgs.join(" ")}`);
}

main();
