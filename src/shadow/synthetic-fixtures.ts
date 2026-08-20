import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runShadowExperiment } from "./experiment.js";
import type { ExecutionPlan } from "../planner/types.js";

export type SyntheticCaseName =
  | "change-implementation-selects-direct-test"
  | "change-shared-utility-selects-dependent-test"
  | "change-imported-json-selects-consumer-test"
  | "change-shared-component-selects-consumer-test";

export interface SyntheticCaseFiles {
  initial: Record<string, string>;
  changedFile: string;
  newContent: string;
}

const t = "import { strict as assert } from 'node:assert'; import { describe, it } from 'node:test';";

export const SYNTHETIC_CASES: Record<SyntheticCaseName, SyntheticCaseFiles> = {
  "change-implementation-selects-direct-test": {
    initial: {
      "src/user.ts": "export function greet(n: string): string { return `Hello, ${n}`; }\n",
      "src/user.test.ts": `${t} import { greet } from './user'; describe('greet', () => { it('greets', () => { assert.equal(greet('A'), 'Hello, A'); }); });\n`,
    },
    changedFile: "src/user.ts",
    newContent: "export function greet(n: string): string { return `Hi, ${n}`; }\n",
  },
  "change-shared-utility-selects-dependent-test": {
    initial: {
      "src/util/math.ts": "export function add(a: number, b: number): number { return a + b; }\n",
      "src/feature/order.ts": "import { add } from '../util/math';\nexport function total(a: number, b: number): number { return add(a, b); }\n",
      "src/feature/order.test.ts": `${t} import { total } from './order'; describe('total', () => { it('adds', () => { assert.equal(total(1, 2), 3); }); });\n`,
    },
    changedFile: "src/util/math.ts",
    newContent: "export function add(a: number, b: number): number { return a + b + 1; }\n",
  },
  "change-imported-json-selects-consumer-test": {
    initial: {
      "src/config/settings.json": '{"rate":100}\n',
      "src/pricing.ts": "import settings from './config/settings.json';\nexport function price(qty: number): number { return qty * settings.rate; }\n",
      "src/pricing.test.ts": `${t} import { price } from './pricing'; describe('price', () => { it('calculates', () => { assert.equal(price(2), 200); }); });\n`,
    },
    changedFile: "src/config/settings.json",
    newContent: '{"rate":150}\n',
  },
  "change-shared-component-selects-consumer-test": {
    initial: {
      "src/ui/Button.tsx": "export function Button({ label }: { label: string }) { return '<button>' + label + '</button>'; }\n",
      "src/forms/Subscribe.tsx": "import { Button } from '../ui/Button';\nexport function Subscribe() { return Button({ label: 'Join' }); }\n",
      "src/forms/Subscribe.test.ts": `${t} import { Subscribe } from './Subscribe'; describe('Subscribe', () => { it('renders', () => { assert.ok(Subscribe().includes('Join')); }); });\n`,
    },
    changedFile: "src/ui/Button.tsx",
    newContent: "export function Button({ label }: { label: string }) { return '<a>' + label + '</a>'; }\n",
  },
};

function createTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "diffci-synthetic-"));
  execSync("git init --quiet", { cwd: dir });
  execSync("git config user.email 'synthetic@diffci.local'", { cwd: dir });
  execSync("git config user.name 'Synthetic'", { cwd: dir });
  execSync("git config core.autocrlf false", { cwd: dir });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "synthetic", version: "1.0.0", type: "module" }));
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", baseUrl: ".", paths: { "@/*": ["./src/*"] }, allowImportingTsExtensions: true, resolveJsonModule: true, noEmit: true }, include: ["**/*.ts", "**/*.tsx", "**/*.json"] }),
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

export interface SyntheticFailureResult {
  caseName: SyntheticCaseName;
  repoPath: string;
  baseSha: string;
  headSha: string;
  plan: ExecutionPlan;
  selectedTests: string[];
  changedFiles: string[];
}

export async function runSyntheticFailureCase(caseName: SyntheticCaseName): Promise<SyntheticFailureResult> {
  const fixture = SYNTHETIC_CASES[caseName];
  const repoPath = createTempRepo();
  for (const [relativePath, content] of Object.entries(fixture.initial)) {
    const full = join(repoPath, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  commitAll(repoPath, "[SYNTHETIC SAFETY EVIDENCE] initial");
  const baseSha = getSha(repoPath);
  writeFileSync(join(repoPath, fixture.changedFile), fixture.newContent);
  commitAll(repoPath, `[SYNTHETIC SAFETY EVIDENCE] ${caseName}`);
  const headSha = getSha(repoPath);
  const result = await runShadowExperiment({ repoPath, baseSha, headSha, repository: "synthetic", diffciVersion: "synthetic" });
  const selectedTests = result.record.plan.selectedTests;
  const changedFiles = result.record.changedFiles;
  return { caseName, repoPath, baseSha, headSha, plan: result.record.plan, selectedTests, changedFiles };
}

export function cleanupSyntheticRepo(result: SyntheticFailureResult): void {
  rmSync(result.repoPath, { recursive: true, force: true });
}
