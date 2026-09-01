/**
 * Inference — turns observed facts into an execution graph, citing what each conclusion came from.
 *
 * THE RULE THAT ORDERS EVERYTHING: prefer what the repository RUNS in CI over what its manifest
 * declares. A workflow is the project's own executable statement of how it builds and tests itself; a
 * `package.json` script is a convenience that CI may or may not use. Generation C derived from the
 * manifest alone and was wrong on four of six repositories.
 *
 * Confidence is not decoration:
 *   OBSERVED  lifted verbatim from a workflow the repository runs
 *   DERIVED   produced by a named rule from facts (e.g. lockfile → package manager)
 *   ASSUMED   a default filling a gap — the level at which every Generation C failure happened
 *
 * REFUSAL IS A RESULT. An engine that cannot tell when it does not understand a pipeline is more
 * dangerous than one that says so, because the confident wrong plan is the one that gets executed.
 */
import { computeCompleteness, confidenceFromCompleteness, type ReferenceNode } from "./reference-graph.js";
import { expressionReferences, pinnedDependencyBasis, resetReferenceIds, resolveAction, resolveScript, serviceReferences } from "./resolve.js";
import type { Confidence, EvidenceRef, InferredOperation, InferredPipeline, ObservedFact, OperationKind, Unresolved } from "./schema.js";

/** Commands that install dependencies, in the form CI actually writes them. */
const INSTALL_PATTERN = /^(npm (ci|install|i)\b|yarn( install)?\b|pnpm (install|i)\b|bun install\b|corepack (npm|yarn|pnpm))/;
/**
 * Actions that install dependencies.
 *
 * A composite action IS an install step even though it contributes no run line. Requiring a run line
 * made `testing-library/jest-dom` — which installs via `bahmutov/npm-install` — look unanalysable for a
 * reason that was about this engine's vocabulary, not the repository.
 */
const INSTALL_ACTION = /^(bahmutov\/npm-install|pnpm\/action-setup|borales\/actions-yarn)/;

/** A run line that is a package-script invocation, e.g. `npm run build` / `yarn test`. */
const SCRIPT_RUN = /^(npm run |yarn (run )?|pnpm (run )?|bun run )([A-Za-z0-9:_-]+)/;

const KIND_BY_SCRIPT: Array<[RegExp, OperationKind]> = [
  // `test:coverage` is html-webpack-plugin's real CI test command. Matching only exact `test` hid the
  // single most informative row in the benchmark behind a refusal.
  [/^test(:|$)/i, "test"],
  [/^(unit|jest|vitest)$/i, "test"],
  [/^(build|compile|bundle|prepack|prepare)$/i, "build"],
  [/^(lint|eslint|lint:js)$/i, "lint"],
  [/^(typecheck|tsc|types|check-types)$/i, "typecheck"],
  [/^(generate|codegen|prebuild)$/i, "generate"],
  [/^(audit|security)$/i, "security"],
];

function kindOfScript(script: string): OperationKind {
  for (const [pattern, kind] of KIND_BY_SCRIPT) if (pattern.test(script)) return kind;
  return "unknown";
}

/** Split a CI run line into argv without a shell. Refuses anything with shell control characters. */
function argvOf(line: string): { argv: string[]; unresolved?: Unresolved } {
  if (/[|&;<>$`(){}]/.test(line)) {
    return {
      argv: [],
      unresolved: { what: line, why: "contains shell control characters; running it would need a shell, which this engine does not model" },
    };
  }
  return { argv: line.split(/\s+/).filter(Boolean) };
}

function evidenceOf(facts: ObservedFact[]): EvidenceRef[] {
  return facts.map((f) => f.evidence);
}

/**
 * The workflow job that most plausibly runs the test suite.
 *
 * Chosen by evidence, not by name-guessing: the job whose steps include an install AND a
 * test-shaped invocation. When several qualify the first in file order wins, deterministically.
 */
function primaryJob(facts: ObservedFact[]): string | undefined {
  const byJob = new Map<string, ObservedFact[]>();
  for (const f of facts) {
    const key = f.attributes?.workflow && f.attributes?.job ? `${f.attributes.workflow}#${f.attributes.job}` : undefined;
    if (!key) continue;
    byJob.set(key, [...(byJob.get(key) ?? []), f]);
  }
  // A job qualifies when it EXECUTES something recognisable — a package script or a test runner.
  //
  // Install is deliberately NOT required to be a run line in the same job. Real CI frequently installs
  // through a composite action, and `ant-design` installs with `ut` (utoo), a package manager this
  // engine has never heard of. Requiring both produced five identical refusals that read like analysis
  // and were an artefact of this file's own vocabulary.
  let best: { key: string; score: number } | undefined;
  for (const [key, jobFacts] of byJob) {
    const runs = jobFacts.filter((f) => f.kind === "workflow.step.run").map((f) => f.value);
    const executes = runs.filter((r) => SCRIPT_RUN.test(r) || /\b(jest|vitest|mocha|ava|tsc|eslint)\b/.test(r));
    if (executes.length === 0) continue;
    // Prefer the job running the most recognised operations; insertion order breaks ties, so the choice
    // is deterministic across runs on one tree.
    const score = executes.length + (runs.some((r) => INSTALL_PATTERN.test(r)) ? 1 : 0);
    if (!best || score > best.score) best = { key, score };
  }
  return best?.key;
}

/**
 * Builds the execution graph for one repository.
 *
 * Never executes anything. Reads facts only.
 */
export function inferPipeline(repoPath: string, repository: string, headSha: string, facts: ObservedFact[], now: string): InferredPipeline {
  resetReferenceIds();
  const operations: InferredOperation[] = [];
  const unresolved: Unresolved[] = [];
  const references: ReferenceNode[] = [];
  const basis = pinnedDependencyBasis(facts);

  const workflowRuns = facts.filter((f) => f.kind === "workflow.step.run");
  const job = primaryJob(facts);
  const jobRuns = job
    ? workflowRuns.filter((f) => `${f.attributes?.workflow}#${f.attributes?.job}` === job)
    : [];

  // --- runtime, from what the repository pins for itself ---
  const nodeFile = facts.find((f) => f.kind === "nodeVersionFile");
  const setupNode = facts.find((f) => f.kind === "workflow.step.uses" && f.value.startsWith("actions/setup-node"));
  const runtimeVersion = setupNode?.attributes?.nodeVersion ?? nodeFile?.value;
  const runtimeSource = setupNode?.evidence ?? nodeFile?.evidence;

  // --- environment the workflow sets for the chosen job ---
  const environment: Record<string, string> = {};
  for (const f of facts) {
    if (f.kind !== "workflow.env") continue;
    if (job && `${f.attributes?.workflow}#${f.attributes?.job}` !== job) continue;
    const [key, ...rest] = f.value.split("=");
    if (key) environment[key] = rest.join("=");
  }

  /**
   * Adds an operation, resolving what it depends on and DERIVING confidence and executability.
   *
   * Nothing here assigns confidence. INFERENCE_01 did, and that is how a plausible `npm install` was
   * labelled OBSERVED while the thing that made it irreproducible — no pinned dependency basis — went
   * unrecorded.
   */
  const add = (
    id: string,
    kind: OperationKind,
    command: string[],
    sawVerbatim: boolean,
    evidence: EvidenceRef[],
    dependsOn: string[],
    opUnresolved: Unresolved[] = [],
    extraRefs: ReferenceNode[] = [],
  ): void => {
    const own: ReferenceNode[] = [...extraRefs];
    if (evidence[0] && command.length > 0) {
      const joined = command.join(" ");
      own.push(...expressionReferences(joined, evidence[0]));
      const scriptMatch = SCRIPT_RUN.exec(joined);
      if (scriptMatch?.[4]) own.push(...resolveScript(repoPath, scriptMatch[4], evidence[0]));
    }
    references.push(...own);

    const scriptsResolved = own.filter((n) => n.kind === "SCRIPT_REFERENCE").every((n) => n.resolution === "RESOLVED");
    const requirementsMet = {
      "a resolved command": command.length > 0,
      "a known working directory": true,
      "all referenced scripts resolved": scriptsResolved,
      "a pinned dependency basis (lockfile or packageManager field)": basis.pinned,
      "a resolved package manager": command.length > 0,
    };
    const completeness = computeCompleteness(kind, requirementsMet, own);
    const confidence = confidenceFromCompleteness(sawVerbatim, completeness);

    operations.push({
      id,
      kind,
      command,
      workingDirectory: ".",
      ...(runtimeVersion && runtimeSource ? { runtime: { name: "node" as const, version: runtimeVersion, source: runtimeSource } } : {}),
      environment,
      dependsOn,
      evidence,
      confidence,
      unresolved: opUnresolved,
      executable: completeness.executable,
      missingRequirements: completeness.missing,
      blockedBy: completeness.blockedBy.map((n) => n.id),
    });
  };

  const serviceRefs = serviceReferences(facts, job);
  const actionRefs = facts
    .filter((f) => f.kind === "workflow.step.uses" && (!job || `${f.attributes?.workflow}#${f.attributes?.job}` === job))
    .map((f) => resolveAction(repoPath, f.value, f.evidence));
  references.push(...serviceRefs, ...actionRefs);

  add("checkout", "checkout", ["git", "checkout", headSha], false, [], []);

  // --- install: the workflow's own line if there is one, else the lockfile rule ---
  const installFact = jobRuns.find((f) => INSTALL_PATTERN.test(f.value)) ?? workflowRuns.find((f) => INSTALL_PATTERN.test(f.value));
  if (installFact) {
    const { argv, unresolved: u } = argvOf(installFact.value);
    if (argv.length > 0) {
      add("install", "install", argv, true, [installFact.evidence], ["checkout"]);
    } else if (u) {
      unresolved.push(u);
      add("install", "install", [], true, [installFact.evidence], ["checkout"], [u]);
      operations[operations.length - 1]!.refusalReason = u.why;
    }
  } else if (facts.some((f) => f.kind === "workflow.step.uses" && INSTALL_ACTION.test(f.value))) {
    // The repository installs through a composite action. That IS the install step and is recorded as
    // observed — but its argv is not knowable without resolving the action, so no command is proposed.
    const action = facts.find((f) => f.kind === "workflow.step.uses" && INSTALL_ACTION.test(f.value))!;
    const u: Unresolved = {
      what: `install is performed by the composite action ${action.value}`,
      why: "a composite action is not a command this engine can execute directly; its effect is an install but its argv is unknown",
      evidence: action.evidence,
    };
    unresolved.push(u);
    add("install", "install", [], true, [action.evidence], ["checkout"], [u]);
    operations[operations.length - 1]!.refusalReason = u.why;
  } else {
    const lock = facts.find((f) => f.kind === "lockfile.present");
    const byLock: Record<string, string[]> = {
      "pnpm-lock.yaml": ["corepack", "pnpm", "install", "--frozen-lockfile"],
      "yarn.lock": ["corepack", "yarn", "install", "--immutable"],
      "package-lock.json": ["npm", "ci", "--no-audit", "--no-fund"],
    };
    if (lock && byLock[lock.value]) {
      add("install", "install", byLock[lock.value]!, false, [lock.evidence], ["checkout"]);
    } else {
      // The Generation C failure mode, now explicit: no workflow line AND no lockfile means the
      // install command is a GUESS. eslint-plugin-vue died exactly here.
      const u: Unresolved = {
        what: "install command",
        why: "no workflow install step and no lockfile - any install command would be an assumption",
      };
      unresolved.push(u);
      add("install", "install", [], false, [], ["checkout"], [u]);
      operations[operations.length - 1]!.refusalReason = u.why;
    }
  }

  // --- every other run line in the chosen job, in order, as its own operation ---
  let previous = "install";
  for (const [i, fact] of jobRuns.entries()) {
    if (fact === installFact) continue;
    const { argv, unresolved: u } = argvOf(fact.value);
    const scriptMatch = SCRIPT_RUN.exec(fact.value);
    const kind: OperationKind = scriptMatch
      ? kindOfScript(scriptMatch[4]!)
      : /\b(jest|vitest|mocha|ava)\b/.test(fact.value)
        ? "test"
        : /\btsc\b/.test(fact.value)
          ? "typecheck"
          : /\beslint\b/.test(fact.value)
            ? "lint"
            : "unknown";
    const id = `${kind}-${i}`;
    if (argv.length === 0 && u) {
      unresolved.push(u);
      add(id, kind, [], true, [fact.evidence], [previous], [u]);
      operations[operations.length - 1]!.refusalReason = u.why;
      continue;
    }
    add(id, kind, argv, true, [fact.evidence], [previous]);
    previous = id;
  }

  // --- refusal: no workflow evidence at all means we are back to guessing ---
  const refusal =
    jobRuns.length === 0
      ? {
          reason:
            workflowRuns.length === 0
              ? "no GitHub Actions workflow steps were found, so how this repository actually runs CI is unknown"
              : "no workflow job both installs dependencies and runs tests, so the canonical pipeline could not be identified",
          evidence: evidenceOf(facts.filter((f) => f.kind === "workflow.job").slice(0, 5)),
        }
      : undefined;

  // THE HARD BOUNDARY. An incomplete causal execution path means a decision engine must not act on
  // this pipeline, however plausible the commands look.
  const nonExecutable = operations.filter((o) => !o.executable && o.kind !== "checkout");
  const optimisable = !refusal && nonExecutable.length === 0;
  const optimisationRefusal = optimisable
    ? undefined
    : refusal
      ? refusal.reason
      : `${nonExecutable.length} operation(s) are not executable: ${nonExecutable
          .map((o) => `${o.id} (${[...o.missingRequirements, ...o.blockedBy].join(", ")})`)
          .join("; ")}`;

  return {
    schema: "diffci.ci.inference/v1",
    repository,
    headSha,
    facts,
    operations,
    unresolved,
    references,
    optimisable,
    ...(optimisationRefusal ? { optimisationRefusal } : {}),
    ...(refusal ? { refusal } : {}),
    producedAt: now,
  };
}
