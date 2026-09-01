/**
 * CI_CONFIGURATION_INFERENCE_01 — the benchmark against the six frozen E2 REDs.
 *
 * Those six repositories defeated generic command derivation during Generation C qualification. They are
 * the BENCHMARK, not a to-do list: none is repaired by hand, and success is not "make all six green".
 * That framing would produce six repository-specific patches and teach the engine nothing.
 *
 * For each, the row is:
 *
 *   old generic derivation → inferred real-CI plan → repository evidence → known execution outcome
 *
 * and the question is whether inference from repository evidence alone WOULD HAVE AVOIDED the known
 * failure — without being told what the failure was.
 *
 * A CORRECT_REFUSAL scores as a success. An optimiser that cannot tell when it fails to understand a
 * pipeline is more dangerous than one that says so.
 *
 * It clones at the pinned tree and reads files. It NEVER executes the repository.
 *
 * Usage: npm run ci:benchmark -- --work <dir> [--out <dir>]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { collectEvidence } from "../src/ci-inference/evidence.js";
import { inferPipeline } from "../src/ci-inference/infer.js";
import { validateOperation, type BenchmarkVerdict, type InferenceBenchmarkRow, type InferredPipeline } from "../src/ci-inference/schema.js";

/** The six frozen REDs, with the generic derivation and the failure each produced. Transcribed from evidence. */
interface BenchmarkEntry { repository: string; headSha: string; genericDerivation: { install: string[]; build?: string[]; testModule?: string; testArgs?: string[] }; knownFailure: { stage: string; detail: string } }

const BENCHMARK: BenchmarkEntry[] = [
  {
    repository: "lint-staged/lint-staged",
    headSha: "d0c1517b61f4805a319ae416f50b1d5bdf3e137f",
    genericDerivation: { install: ["npm", "ci", "--no-audit", "--no-fund"], testModule: "node_modules/vitest/vitest.mjs", testArgs: ["run"] },
    knownFailure: { stage: "test", detail: "2 e2e tests failed on both runs: test/e2e/stdin-config.test.js, test/e2e/no-stash.test.js (75/77 files green)" },
  },
  {
    repository: "jantimon/html-webpack-plugin",
    headSha: "cf9c7012003b8d71783d6c2d72f357616957b99c",
    genericDerivation: { install: ["npm", "ci", "--no-audit", "--no-fund"], testModule: "node_modules/jest/bin/jest.js", testArgs: [] },
    knownFailure: { stage: "install", detail: "npm error code ERESOLVE at 1.5s" },
  },
  {
    repository: "vuejs/eslint-plugin-vue",
    headSha: "f3a027627472216e17e812f5324059f45d156298",
    genericDerivation: { install: ["npm", "install", "--no-audit", "--no-fund"], build: ["npm", "run", "build"], testModule: "node_modules/vitest/vitest.mjs", testArgs: ["run"] },
    knownFailure: { stage: "install", detail: "Cannot read properties of null (reading 'edgesOut') - no lockfile, fell through to npm install" },
  },
  {
    repository: "testing-library/jest-dom",
    headSha: "3782c78b3dc9824675afe0cb8f1722f8c96f494d",
    genericDerivation: { install: ["npm", "install", "--no-audit", "--no-fund"], build: ["npm", "run", "build"], testModule: "node_modules/vitest/vitest.mjs", testArgs: ["run"] },
    knownFailure: { stage: "test", detail: "CONTRADICTORY_EXECUTION_EVIDENCE: exit 1, 8 test files failed, no tests ran - repo drives vitest via `kcd-scripts test`" },
  },
  {
    repository: "ant-design/ant-design",
    headSha: "c5dbf3f09b406586d5ce6ce0a3d634d1a07b4f04",
    genericDerivation: { install: ["npm", "ci", "--no-audit", "--no-fund"], build: ["npm", "run", "build"], testModule: "node_modules/jest/bin/jest.js", testArgs: [] },
    knownFailure: { stage: "build", detail: "JavaScript heap out of memory after 235s install + 83s build" },
  },
  {
    repository: "vuejs/vue-loader",
    headSha: "698636508e08f5379a57eaf086b5ff533af8e051",
    genericDerivation: { install: ["npm", "ci", "--no-audit", "--no-fund"], build: ["npm", "run", "build"], testModule: "node_modules/jest/bin/jest.js", testArgs: [] },
    knownFailure: { stage: "test", detail: "5 tests failed on both runs (5, 5)" },
  },
];

function flag(key: string): string | undefined {
  const i = process.argv.indexOf(`--${key}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function clone(repository: string, headSha: string, into: string): boolean {
  if (existsSync(join(into, ".git"))) return true;
  try {
    execFileSync("git", ["clone", "--quiet", "--filter=blob:none", "--no-checkout", `https://github.com/${repository}.git`, into], { stdio: "pipe" });
    execFileSync("git", ["-C", into, "checkout", "--quiet", headSha], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Scores an inference against a known failure, WITHOUT telling the engine what the failure was.
 *
 * THE BAR IS AVOIDANCE, NOT DIFFERENCE. An earlier version scored CORRECT_INFERENCE whenever the
 * inferred command differed from the generic one, and it awarded `vuejs/eslint-plugin-vue` a win for
 * inferring `npm install` against a generic `npm install --no-audit --no-fund` — commands that differ
 * only in flags that cannot affect an arborist crash. That is a flattering score for no work.
 *
 * So a win now requires a difference that PLAUSIBLY ADDRESSES the recorded failure, and anything that
 * cannot be decided without executing is reported as such rather than counted.
 */
function score(
  row: { knownFailure: { stage: string; detail: string } },
  inferred: InferredPipeline,
  generic: { install: string[] },
): { verdict: BenchmarkVerdict; reason: string } {
  if (inferred.refusal) {
    return { verdict: "CORRECT_REFUSAL", reason: `refused to describe the pipeline: ${inferred.refusal.reason}` };
  }

  const install = inferred.operations.find((o) => o.kind === "install");
  const executable = inferred.operations.filter(
    (o) => o.confidence === "OBSERVED" && o.command.length > 0 && o.kind !== "checkout" && o.kind !== "install",
  );

  if (row.knownFailure.stage === "install") {
    if (install?.refusalReason) {
      return { verdict: "CORRECT_REFUSAL", reason: `declined to propose an install command: ${install.refusalReason}` };
    }
    if (!install || install.command.length === 0) {
      return { verdict: "INSUFFICIENT_EVIDENCE", reason: "no install operation could be inferred" };
    }
    const inferredCmd = install.command.join(" ");
    const genericCmd = generic.install.join(" ");
    // Flags that change dependency RESOLUTION are the ones that can address an install failure.
    // --no-audit / --no-fund cannot: they only suppress output.
    const resolutionFlags = /--legacy-peer-deps|--force|--frozen-lockfile|--immutable|--no-frozen-lockfile/;
    const addsResolutionFlag = resolutionFlags.test(inferredCmd) && !resolutionFlags.test(genericCmd);
    const differentManager = install.command[0] !== generic.install[0] || install.command[1] !== generic.install[1];
    if (addsResolutionFlag || differentManager) {
      return {
        verdict: "CORRECT_INFERENCE",
        reason: `install inferred as \`${inferredCmd}\` (${install.confidence}) — materially different from the generic \`${genericCmd}\` in a way that addresses the recorded failure`,
      };
    }
    return {
      verdict: "INCORRECT_INFERENCE",
      reason: `install inferred as \`${inferredCmd}\`, which differs from the generic \`${genericCmd}\` only in flags that cannot affect the recorded failure`,
    };
  }

  if (row.knownFailure.stage === "test") {
    if (executable.length === 0) {
      return { verdict: "INSUFFICIENT_EVIDENCE", reason: "no executable operation could be inferred from workflow evidence" };
    }
    const proposed = executable.map((o) => o.command.join(" ")).join(" && ");
    // The repository's own command is strictly better evidence than a synthesised runner invocation —
    // but whether it AVOIDS a genuine test failure cannot be known without executing it, and this
    // benchmark executes nothing. Reported honestly rather than counted as a win.
    return {
      verdict: "INSUFFICIENT_EVIDENCE",
      reason: `proposes the repository's own \`${proposed}\` (OBSERVED) instead of a synthesised runner invocation, but whether that avoids a genuine test failure cannot be decided without executing it`,
    };
  }

  return {
    verdict: "INSUFFICIENT_EVIDENCE",
    reason: "the failure was a runner resource limit, which repository evidence alone cannot predict",
  };
}


function main(): void {
  const work = resolve(flag("work") ?? "ci-inference-work");
  const outDir = resolve(flag("out") ?? "docs/evidence/ci-inference-01");
  mkdirSync(work, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  console.log(`\n  CI_CONFIGURATION_INFERENCE_01 - benchmark against the six frozen E2 REDs`);
  console.log(`  These repositories are the BENCHMARK. None is repaired by hand.\n`);

  const rows: InferenceBenchmarkRow[] = [];
  for (const entry of BENCHMARK) {
    const dir = join(work, entry.repository.replace("/", "__"));
    process.stdout.write(`  ${entry.repository.padEnd(34)} `);
    if (!clone(entry.repository, entry.headSha, dir)) {
      console.log("CLONE FAILED - recorded, not scored");
      continue;
    }
    const facts = collectEvidence(dir);
    const inferred = inferPipeline(entry.repository, entry.headSha, facts, new Date().toISOString());
    for (const op of inferred.operations) {
      const problems = validateOperation(op);
      if (problems.length > 0) throw new Error(`schema violation: ${problems.join("; ")}`);
    }
    const { verdict, reason } = score(entry, inferred, entry.genericDerivation);
    rows.push({
      schema: "diffci.ci.inference.benchmark/v1",
      repository: entry.repository,
      headSha: entry.headSha,
      genericDerivation: entry.genericDerivation,
      knownFailure: entry.knownFailure,
      inferred,
      verdict,
      verdictReason: reason,
    });
    console.log(`${verdict}`);
    console.log(`      facts ${String(facts.length).padStart(4)}   operations ${String(inferred.operations.length).padStart(2)}   unresolved ${inferred.unresolved.length}`);
    console.log(`      ${reason}`);
  }

  writeFileSync(join(outDir, "benchmark.json"), `${JSON.stringify({ schema: "diffci.ci.inference.benchmark/v1", producedAt: new Date().toISOString(), rows }, null, 2)}\n`);

  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
  console.log(`\n  VERDICTS`);
  for (const [k, v] of Object.entries(counts).sort()) console.log(`    ${k.padEnd(24)} ${v}`);
  console.log(`\n  written to ${join(outDir, "benchmark.json")}\n`);
}

main();
