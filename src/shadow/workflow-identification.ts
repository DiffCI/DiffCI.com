/**
 * Mechanical identification of a repository's CI evidence workflow and stage layout (2026-09-05,
 * seamless-install requirement: no founder intervention per install).
 *
 * The evidence standard (research note, step 2) is unchanged: a workflow is evidence only if it is
 * PROVEN to be the work the prediction is about. What changes is who proves it. Instead of a person
 * naming the workflow file, this module reads the repository's own files and shows its work:
 *
 *   1. every workflow under .github/workflows is parsed (YAML) and kept only if it runs on push
 *      and/or pull_request (a scheduled, manual-only or release workflow is not CI evidence);
 *   2. every `run:` step's shell is split into commands and every `npm run X` / `npm test` /
 *      `pnpm X` / `yarn X` is resolved through package.json scripts (depth-limited) to the commands
 *      that actually execute - `npm run check` on DiffCI.com resolves to `tsc --noEmit` and
 *      `tsx --test "tests/**\/*.test.ts"`, which is how the step is known to run tests;
 *   3. a step is classified from the commands it resolves to (test runner -> test, tsc -> typecheck,
 *      linters -> lint, bundlers -> build, e2e runners -> e2e); a step whose commands span more than
 *      one stage keeps the highest-priority stage and is marked inseparable (measured, never
 *      estimated) - the same rule the hand-written configurations used;
 *   4. the evidence workflow is the push/PR-triggered workflow that runs the repository's tests. If
 *      several do, the one with the most separable test work on the default branch wins and the
 *      others are recorded, not silently dropped. If none does, the result is NONE_FOUND with the
 *      reason - and the report says so.
 *
 * The derivation object returned alongside the configuration is persisted verbatim, so every
 * automatically identified repository carries the evidence for its own identification. The first
 * executed run of the identified workflow then verifies the derived job/step names against GitHub's
 * real jobs (stage sweep) before any economics row is written.
 *
 * Pure. No network, no D1. Nothing here may guess: "ci.yml" as a name proves nothing and is never
 * consulted.
 */
import { parse as parseYaml } from "yaml";
import type { CiStage } from "./stage-classification.js";
import type { JobRule, StageClassificationConfig, StepRule } from "./stage-classification-config.js";

export const WORKFLOW_IDENTIFICATION_VERSION = 1;

/** DiffCI's own observation workflows are never evidence of the repository's CI. */
const DIFFCI_WORKFLOW_FILES = new Set(["diffci-observe.yml", "diffci-observe.yaml", "diffci-shadow.yml", "diffci-shadow.yaml"]);

export interface WorkflowFile {
  /** ".github/workflows/<file>" */
  path: string;
  content: string;
}

export interface IdentificationInput {
  workflows: WorkflowFile[];
  /** Root package.json "scripts", or undefined when there is no package.json. */
  packageScripts?: Record<string, string>;
  defaultBranch: string;
}

export interface ResolvedStep {
  jobKey: string;
  jobName: string;
  stepName: string;
  /** The commands the step resolves to, after script expansion. */
  commands: string[];
  stages: CiStage[];
  stage?: CiStage;
  inseparable: boolean;
}

export interface WorkflowCandidate {
  path: string;
  name: string;
  triggers: { push: boolean; pushDefaultBranch: boolean; pullRequest: boolean };
  jobs: { key: string; name: string; steps: ResolvedStep[] }[];
  testSteps: number;
  separableTestSteps: number;
  score: number;
  excludedReason?: string;
}

export interface IdentificationDerivation {
  version: number;
  source: "auto";
  derivedAt: string;
  defaultBranch: string;
  candidates: WorkflowCandidate[];
  chosen?: { path: string; reason: string };
  alsoRunTests: string[];
}

export type IdentificationResult =
  | { status: "IDENTIFIED"; evidenceWorkflowPaths: string[]; stageClassification: StageClassificationConfig; derivation: IdentificationDerivation }
  | { status: "NONE_FOUND"; reason: string; derivation: IdentificationDerivation };

// --- command classification -------------------------------------------------------------------

const TEST_RUNNERS = /\b(vitest|jest|mocha|ava|uvu|tap|tape|node\s+--test|tsx\s+--test|ts-node\s+--test|bun\s+test|deno\s+test|c8\s|nyc\s)\b/;
const E2E_RUNNERS = /\b(playwright\s+test|cypress\s+run|cypress\s+open|wdio|nightwatch|puppeteer)\b/;
const TYPECHECK = /(^|\s)(tsc|vue-tsc|svelte-check)(\s|$)|--noEmit|\btypecheck\b|\btype-check\b/;
const LINT = /\b(eslint|prettier|biome|oxlint|stylelint|tslint|dprint|markdownlint|knip)\b/;
const BUILD = /\b(next\s+build|vite\s+build|nuxt\s+build|astro\s+build|tsup|rollup|webpack|esbuild|parcel|turbo\s+run\s+build|nx\s+build|tsc\s+-b|tsc\s+--build|unbuild)\b/;
const INSTALL = /^(npm\s+(ci|install|i)\b|pnpm\s+(install|i)\b|yarn(\s+install)?\s*$|yarn\s+install\b|bun\s+install\b)/;

export function classifyCommand(command: string): CiStage | "install" | undefined {
  const c = command.trim();
  if (!c) return undefined;
  if (INSTALL.test(c)) return "install";
  if (E2E_RUNNERS.test(c)) return "e2e";
  if (TEST_RUNNERS.test(c)) return "test";
  if (TYPECHECK.test(c)) return "typecheck";
  if (LINT.test(c)) return "lint";
  if (BUILD.test(c)) return "build";
  return undefined;
}

const STAGE_PRIORITY: CiStage[] = ["test", "e2e", "typecheck", "lint", "build", "other"];

/** Splits a shell snippet into individual commands (newlines, &&, ||, ;). Quoted strings are not
 * parsed - a command's own arguments are only ever pattern-matched, never executed. */
export function splitCommands(shell: string): string[] {
  return shell
    .split(/\r?\n|&&|\|\||;/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("#"));
}

/**
 * Expands `npm run X`, `npm test`, `pnpm X`, `pnpm run X`, `yarn X`, `yarn run X`, `bun run X` through
 * package.json scripts, recursively (depth-limited, cycle-safe). Commands that are not script
 * invocations are returned as-is.
 */
export function resolveCommands(commands: readonly string[], scripts: Record<string, string> | undefined, depth = 0, seen: Set<string> = new Set()): string[] {
  const out: string[] = [];
  for (const raw of commands) {
    const c = raw.trim();
    const script = scriptNameOf(c, scripts);
    if (script !== undefined && scripts && scripts[script] !== undefined && depth < 4 && !seen.has(script)) {
      const next = new Set(seen);
      next.add(script);
      // npm runs pre<script> and post<script> hooks implicitly - they are part of what executes.
      const chain = [`pre${script}`, script, `post${script}`].filter((s) => scripts[s] !== undefined);
      for (const s of chain) out.push(...resolveCommands(splitCommands(scripts[s]!), scripts, depth + 1, next));
    } else {
      out.push(c);
    }
  }
  return out;
}

function scriptNameOf(command: string, scripts: Record<string, string> | undefined): string | undefined {
  if (!scripts) return undefined;
  let m = command.match(/^(?:npm|pnpm|yarn|bun)\s+run(?:-script)?\s+(?:--\S+\s+)*([A-Za-z0-9:._-]+)/);
  if (m) return m[1];
  m = command.match(/^(?:npm|pnpm|yarn|bun)\s+(test|start|build|lint)\b/);
  if (m && scripts[m[1]!] !== undefined) return m[1];
  m = command.match(/^(?:pnpm|yarn|bun)\s+([A-Za-z0-9:._-]+)(?:\s|$)/);
  if (m && scripts[m[1]!] !== undefined && !["install", "i", "add", "exec", "dlx", "npx", "run"].includes(m[1]!)) return m[1];
  return undefined;
}

export function classifyStep(commands: readonly string[]): { stages: CiStage[]; stage?: CiStage; inseparable: boolean } {
  const classes = new Set<CiStage | "install">();
  for (const c of commands) {
    const k = classifyCommand(c);
    if (k) classes.add(k);
  }
  const stages = STAGE_PRIORITY.filter((s) => classes.has(s));
  if (stages.length === 0) return { stages: [], inseparable: false };
  const stage = stages[0]!;
  // Inseparable when the same measured step also does other stage work or a dependency install.
  const inseparable = stages.length > 1 || classes.has("install");
  return { stages, stage, inseparable };
}

// --- workflow parsing ---------------------------------------------------------------------------

type Yaml = Record<string, unknown>;

function asRecord(v: unknown): Yaml | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Yaml) : undefined;
}

function triggersOf(on: unknown, defaultBranch: string): WorkflowCandidate["triggers"] {
  const t = { push: false, pushDefaultBranch: false, pullRequest: false };
  const consider = (key: string, cfg: unknown) => {
    if (key === "push") {
      t.push = true;
      const r = asRecord(cfg);
      const branches = r?.branches;
      const ignore = r?.["branches-ignore"];
      const listed = Array.isArray(branches) ? branches.map(String) : typeof branches === "string" ? [branches] : undefined;
      const ignored = Array.isArray(ignore) ? ignore.map(String) : typeof ignore === "string" ? [ignore] : [];
      const matches = (p: string) => p === defaultBranch || p === "*" || p === "**" || (p.endsWith("*") && defaultBranch.startsWith(p.slice(0, -1)));
      t.pushDefaultBranch = (listed === undefined || listed.some(matches)) && !ignored.some((p) => p === defaultBranch);
    }
    if (key === "pull_request" || key === "pull_request_target") t.pullRequest = true;
  };
  if (typeof on === "string") consider(on, undefined);
  else if (Array.isArray(on)) for (const k of on) consider(String(k), undefined);
  else {
    const r = asRecord(on);
    if (r) for (const [k, v] of Object.entries(r)) consider(k, v);
  }
  return t;
}

/** GitHub's default name for an unnamed step: "Run <first line of run>" or "Run <uses ref>". */
export function defaultStepName(step: Yaml): string {
  if (typeof step.name === "string" && step.name.trim()) return step.name.trim();
  if (typeof step.run === "string") return `Run ${step.run.split(/\r?\n/)[0]!.trim()}`;
  if (typeof step.uses === "string") return `Run ${step.uses.trim()}`;
  return "Run";
}

export function parseWorkflow(file: WorkflowFile, input: IdentificationInput): WorkflowCandidate {
  const fileName = file.path.split("/").pop() ?? file.path;
  const base: WorkflowCandidate = { path: file.path, name: fileName, triggers: { push: false, pushDefaultBranch: false, pullRequest: false }, jobs: [], testSteps: 0, separableTestSteps: 0, score: 0 };
  if (DIFFCI_WORKFLOW_FILES.has(fileName)) return { ...base, excludedReason: "DiffCI's own observation workflow" };
  let doc: unknown;
  try {
    doc = parseYaml(file.content, { maxAliasCount: 200 });
  } catch (error: unknown) {
    return { ...base, excludedReason: `unparseable YAML: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}` };
  }
  const root = asRecord(doc);
  if (!root) return { ...base, excludedReason: "not a workflow document" };
  const name = typeof root.name === "string" ? root.name : fileName;
  // YAML 1.1 parsers read a bare `on:` key as boolean true; the yaml package keeps it as "on".
  const on = root.on ?? root[true as unknown as string];
  const triggers = triggersOf(on, input.defaultBranch);
  const jobsRec = asRecord(root.jobs) ?? {};
  const jobs: WorkflowCandidate["jobs"] = [];
  for (const [key, jobVal] of Object.entries(jobsRec)) {
    const job = asRecord(jobVal);
    if (!job) continue;
    if (typeof job.uses === "string") continue; // reusable-workflow call: its steps live elsewhere
    const jobName = typeof job.name === "string" && job.name.trim() ? job.name.trim() : key;
    const steps: ResolvedStep[] = [];
    for (const s of Array.isArray(job.steps) ? job.steps : []) {
      const step = asRecord(s);
      if (!step || typeof step.run !== "string") continue;
      const commands = resolveCommands(splitCommands(step.run), input.packageScripts);
      const cls = classifyStep(commands);
      steps.push({ jobKey: key, jobName, stepName: defaultStepName(step), commands, ...cls });
    }
    jobs.push({ key, name: jobName, steps });
  }
  const testSteps = jobs.flatMap((j) => j.steps).filter((s) => s.stage === "test" || s.stage === "e2e");
  const separable = testSteps.filter((s) => !s.inseparable);
  const candidate: WorkflowCandidate = { path: file.path, name, triggers, jobs, testSteps: testSteps.length, separableTestSteps: separable.length, score: 0 };
  if (!triggers.push && !triggers.pullRequest) return { ...candidate, excludedReason: "not triggered by push or pull_request" };
  if (testSteps.length === 0) return { ...candidate, excludedReason: "no step runs a test command" };
  candidate.score = (triggers.pushDefaultBranch ? 100 : triggers.push ? 40 : 20) + separable.length * 10 + testSteps.length * 3;
  return candidate;
}

/** Builds the explicit stage configuration from the chosen workflow's resolved steps - every rule
 * names a real job and step as GitHub will report them. */
export function deriveStageClassification(candidate: WorkflowCandidate): StageClassificationConfig {
  const jobs: JobRule[] = [];
  const steps: StepRule[] = [];
  for (const job of candidate.jobs) {
    const classified = job.steps.filter((s) => s.stage !== undefined);
    for (const s of classified) steps.push({ job: job.name, step: s.stepName, stage: s.stage!, ...(s.inseparable ? { inseparable: true } : {}) });
    // The job's remaining time (checkout, setup-node, install steps without a rule) is real CI work
    // that is not a stage DiffCI reasons about: attribute it explicitly as 'other' rather than leave
    // it unclassified, so the report can total the job honestly.
    jobs.push({ job: job.name, stage: "other" });
  }
  return { version: 1, jobs, steps };
}

export function identifyEvidenceWorkflow(input: IdentificationInput, nowIso: string): IdentificationResult {
  const candidates = input.workflows.map((w) => parseWorkflow(w, input));
  const eligible = candidates.filter((c) => !c.excludedReason);
  const derivationBase = { version: WORKFLOW_IDENTIFICATION_VERSION, source: "auto" as const, derivedAt: nowIso, defaultBranch: input.defaultBranch, candidates };
  if (eligible.length === 0) {
    const reason = input.workflows.length === 0
      ? "the repository has no GitHub Actions workflows"
      : `none of ${input.workflows.length} workflow(s) runs a test command on push or pull_request (${candidates.map((c) => `${c.name}: ${c.excludedReason}`).join("; ")})`;
    return { status: "NONE_FOUND", reason, derivation: { ...derivationBase, alsoRunTests: [] } };
  }
  const ranked = [...eligible].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const chosen = ranked[0]!;
  const alsoRunTests = ranked.slice(1).map((c) => c.path);
  const reason = `${chosen.triggers.pushDefaultBranch ? `runs on push to ${input.defaultBranch}` : chosen.triggers.push ? "runs on push" : "runs on pull_request"}; ${chosen.testSteps} test step(s), ${chosen.separableTestSteps} separable`
    + (alsoRunTests.length ? `; ${alsoRunTests.length} other workflow(s) also run tests and are recorded, not used` : "");
  return {
    status: "IDENTIFIED",
    evidenceWorkflowPaths: [chosen.path],
    stageClassification: deriveStageClassification(chosen),
    derivation: { ...derivationBase, chosen: { path: chosen.path, reason }, alsoRunTests },
  };
}

/**
 * Verification against a real executed run: the derived configuration must name at least one job
 * that GitHub actually reported for the evidence run, and every classified step name must belong to
 * a job that exists. A shape mismatch means the derivation cannot be trusted for THIS run and the
 * repository goes back to awaiting identification, with the mismatch recorded.
 */
export function verifyDerivedShape(config: StageClassificationConfig, observedJobs: readonly { jobName: string; steps?: readonly { name: string }[] }[]): { ok: boolean; detail: string } {
  const observedNames = new Set(observedJobs.map((j) => j.jobName));
  const configuredJobs = new Set([...config.jobs.map((j) => j.job), ...config.steps.map((s) => s.job)]);
  const present = [...configuredJobs].filter((j) => observedNames.has(j));
  if (present.length === 0) return { ok: false, detail: `none of the derived jobs (${[...configuredJobs].join(", ")}) appear in the executed run (${[...observedNames].join(", ")})` };
  const missingSteps: string[] = [];
  for (const rule of config.steps) {
    const job = observedJobs.find((j) => j.jobName === rule.job);
    if (!job) continue;
    if (job.steps && !job.steps.some((s) => s.name === rule.step)) missingSteps.push(`${rule.job} :: ${rule.step}`);
  }
  if (missingSteps.length > 0) return { ok: false, detail: `derived step(s) not present in the executed run: ${missingSteps.join("; ")}` };
  return { ok: true, detail: `jobs matched: ${present.join(", ")}` };
}
