/**
 * Inference — turns observed facts into an execution graph, citing what each conclusion came from.
 *
 * THE RULE THAT ORDERS EVERYTHING: prefer what the repository RUNS in CI over what its manifest
 * declares. A workflow is the project's own executable statement of how it builds and tests itself; a
 * `package.json` script is a convenience that CI may or may not use. Generation C derived from the
 * manifest alone and was wrong on four of six repositories.
 *
 * INFERENCE_03: EVERY JOB IS KEPT. The previous version collapsed a workflow to a single `primaryJob`
 * chosen by how many recognised operations it ran, and on `html-webpack-plugin` that made the lint job
 * beat the build job — so the engine described the lint pipeline, proposed no test step, and still
 * reported the pipeline executable. `lint-staged` failed identically.
 *
 * The fix is not better weights. A workflow has several purposes and "which job wins" is the wrong
 * question; `jobs.ts` asks which path produces a requested outcome instead. `lint` and `security` stay
 * in the graph as nodes, because optimising the whole pipeline will need them.
 *
 * Confidence and executability are DERIVED from reference-graph completeness, never assigned.
 */
import { jobProvides, type InferredJob } from "./jobs.js";
import { computeCompleteness, confidenceFromCompleteness, type ReferenceNode } from "./reference-graph.js";
import { expressionReferences, pinnedDependencyBasis, resetReferenceIds, resolveAction, resolveScript, serviceReferences } from "./resolve.js";
import type { EvidenceRef, InferredOperation, InferredPipeline, ObservedFact, OperationKind, Unresolved } from "./schema.js";

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
  // `test:coverage` is html-webpack-plugin's real CI test command.
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

/** Classifies a raw run line into an operation kind, from the command rather than the step's name. */
function kindOfRunLine(line: string): OperationKind {
  if (INSTALL_PATTERN.test(line)) return "install";
  const script = SCRIPT_RUN.exec(line);
  if (script?.[4]) return kindOfScript(script[4]);
  if (/\b(jest|vitest|mocha|ava)\b/.test(line)) return "test";
  if (/\btsc\b/.test(line)) return "typecheck";
  if (/\beslint\b/.test(line)) return "lint";
  if (/\baudit\b/.test(line)) return "security";
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

/**
 * Builds the execution graph for one repository — every job, not one.
 *
 * Never executes anything. Reads facts only.
 */
export function inferPipeline(repoPath: string, repository: string, headSha: string, facts: ObservedFact[], now: string): InferredPipeline {
  resetReferenceIds();
  const references: ReferenceNode[] = [];
  const unresolved: Unresolved[] = [];
  const basis = pinnedDependencyBasis(facts);

  // --- runtime, from what the repository pins for itself ---
  const nodeFile = facts.find((f) => f.kind === "nodeVersionFile");
  const setupNode = facts.find((f) => f.kind === "workflow.step.uses" && f.value.startsWith("actions/setup-node"));
  const runtimeVersion = setupNode?.attributes?.nodeVersion ?? nodeFile?.value;
  const runtimeSource = setupNode?.evidence ?? nodeFile?.evidence;

  const keyOf = (f: ObservedFact): string | undefined =>
    f.attributes?.workflow && f.attributes?.job ? `${f.attributes.workflow}#${f.attributes.job}` : undefined;

  const jobKeys: string[] = [];
  for (const f of facts) {
    const key = keyOf(f);
    if (key && !jobKeys.includes(key)) jobKeys.push(key);
  }

  const makeOperation = (
    id: string,
    kind: OperationKind,
    command: string[],
    sawVerbatim: boolean,
    evidence: EvidenceRef[],
    dependsOn: string[],
    environment: Record<string, string>,
    opUnresolved: Unresolved[] = [],
    extraRefs: ReferenceNode[] = [],
  ): InferredOperation => {
    const own: ReferenceNode[] = [...extraRefs];
    if (evidence[0] && command.length > 0) {
      const joined = command.join(" ");
      own.push(...expressionReferences(joined, evidence[0]));
      const scriptMatch = SCRIPT_RUN.exec(joined);
      if (scriptMatch?.[4]) own.push(...resolveScript(repoPath, scriptMatch[4], evidence[0]));
    }
    references.push(...own);

    const scriptsResolved = own.filter((n) => n.kind === "SCRIPT_REFERENCE").every((n) => n.resolution === "RESOLVED");
    const completeness = computeCompleteness(
      kind,
      {
        "a resolved command": command.length > 0,
        "a known working directory": true,
        "all referenced scripts resolved": scriptsResolved,
        "a pinned dependency basis (lockfile or packageManager field)": basis.pinned,
        "a resolved package manager": command.length > 0,
      },
      own,
    );

    return {
      id,
      kind,
      command,
      workingDirectory: ".",
      ...(runtimeVersion && runtimeSource ? { runtime: { name: "node" as const, version: runtimeVersion, source: runtimeSource } } : {}),
      environment,
      dependsOn,
      evidence,
      confidence: confidenceFromCompleteness(sawVerbatim, completeness),
      unresolved: opUnresolved,
      ...(command.length === 0 && opUnresolved[0] ? { refusalReason: opUnresolved[0].why } : {}),
      executable: completeness.executable,
      missingRequirements: completeness.missing,
      blockedBy: completeness.blockedBy.map((n) => n.id),
    };
  };

  const jobs: InferredJob[] = [];
  for (const key of jobKeys) {
    const [workflow, jobName] = key.split("#");
    const jobFacts = facts.filter((f) => keyOf(f) === key);
    const runs = jobFacts.filter((f) => f.kind === "workflow.step.run");
    if (runs.length === 0) continue;

    const environment: Record<string, string> = {};
    for (const f of jobFacts.filter((f) => f.kind === "workflow.env")) {
      const [k, ...rest] = f.value.split("=");
      if (k) environment[k] = rest.join("=");
    }

    // Services and third-party actions this job depends on become reference nodes attached to it.
    const jobRefs = [
      ...serviceReferences(facts, key),
      ...jobFacts.filter((f) => f.kind === "workflow.step.uses").map((f) => resolveAction(repoPath, f.value, f.evidence)),
    ];
    references.push(...jobRefs);

    const operations: InferredOperation[] = [];
    let previous: string | undefined;
    for (const [i, fact] of runs.entries()) {
      const kind = kindOfRunLine(fact.value);
      const { argv, unresolved: u } = argvOf(fact.value);
      if (u) unresolved.push(u);
      const op = makeOperation(
        `${jobName}-${kind}-${i}`,
        kind,
        argv,
        true,
        [fact.evidence],
        previous ? [previous] : [],
        environment,
        u ? [u] : [],
      );
      operations.push(op);
      if (argv.length > 0) previous = op.id;
    }

    // A job with no install run line may still install through a composite action, or rely on the
    // lockfile rule. Recorded so the prerequisite is visible rather than silently absent.
    if (!operations.some((o) => o.kind === "install")) {
      const action = jobFacts.find((f) => f.kind === "workflow.step.uses" && INSTALL_ACTION.test(f.value));
      if (action) {
        const u: Unresolved = {
          what: `install is performed by the composite action ${action.value}`,
          why: "a composite action is not a command this engine can execute directly; its effect is an install but its argv is unknown",
          evidence: action.evidence,
        };
        unresolved.push(u);
        operations.unshift(makeOperation(`${jobName}-install`, "install", [], true, [action.evidence], [], environment, [u]));
      }
    }

    jobs.push({
      id: key,
      workflow: workflow ?? "unknown",
      job: jobName ?? "unknown",
      provides: jobProvides(operations),
      operations,
      blockedBy: [...new Set(operations.flatMap((o) => o.blockedBy))],
    });
  }

  const operations = jobs.flatMap((j) => j.operations);

  const refusal =
    jobs.length === 0
      ? {
          reason: "no GitHub Actions workflow job with executable steps was found, so how this repository runs CI is unknown",
          evidence: facts.filter((f) => f.kind === "workflow.job").slice(0, 5).map((f) => f.evidence),
        }
      : undefined;

  // THE HARD BOUNDARY, unchanged: an incomplete causal execution path means a decision engine must not
  // act. Reported per-purpose by the planner; this is the whole-pipeline view.
  const nonExecutable = operations.filter((o) => !o.executable);
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
    jobs,
    operations,
    unresolved,
    references,
    optimisable,
    ...(optimisationRefusal ? { optimisationRefusal } : {}),
    ...(refusal ? { refusal } : {}),
    producedAt: now,
  };
}
