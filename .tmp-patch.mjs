import { readFileSync, writeFileSync } from "node:fs";

const p = "src/ci-inference/infer.ts";
let s = readFileSync(p, "utf8");

s = s.replace(
  `import type { Confidence, EvidenceRef, InferredOperation, InferredPipeline, ObservedFact, OperationKind, Unresolved } from "./schema.js";`,
  `import { computeCompleteness, confidenceFromCompleteness, type ReferenceNode } from "./reference-graph.js";
import { expressionReferences, pinnedDependencyBasis, resetReferenceIds, resolveAction, resolveScript, serviceReferences } from "./resolve.js";
import type { Confidence, EvidenceRef, InferredOperation, InferredPipeline, ObservedFact, OperationKind, Unresolved } from "./schema.js";`,
);

s = s.replace(
  `export function inferPipeline(repository: string, headSha: string, facts: ObservedFact[], now: string): InferredPipeline {
  const operations: InferredOperation[] = [];
  const unresolved: Unresolved[] = [];`,
  `export function inferPipeline(repoPath: string, repository: string, headSha: string, facts: ObservedFact[], now: string): InferredPipeline {
  resetReferenceIds();
  const operations: InferredOperation[] = [];
  const unresolved: Unresolved[] = [];
  const references: ReferenceNode[] = [];
  const basis = pinnedDependencyBasis(facts);`,
);

const addStart = s.indexOf("  const add = (");
const addEnd = s.indexOf('  add("checkout"');
const newAdd = `  /**
   * Adds an operation, resolving what it depends on and DERIVING confidence and executability.
   *
   * Nothing here assigns confidence. INFERENCE_01 did, and that is how a plausible \`npm install\` was
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
      if (scriptMatch) own.push(...resolveScript(repoPath, scriptMatch[4], evidence[0]));
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
      ...(runtimeVersion ? { runtime: { name: "node", version: runtimeVersion, source: runtimeSource } } : {}),
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

`;
s = s.slice(0, addStart) + newAdd + s.slice(addEnd);

// Call sites previously passed a Confidence literal; they now pass `sawVerbatim`.
s = s.split(', "OBSERVED", ').join(", true, ");
s = s.split(', "DERIVED", ').join(", false, ");
s = s.split(', "ASSUMED", ').join(", false, ");

// Services and `uses:` actions become reference nodes on the install operation.
s = s.replace(
  `  add("checkout", "checkout", ["git", "checkout", headSha], false, [], []);`,
  `  const serviceRefs = serviceReferences(facts, job);
  const actionRefs = facts
    .filter((f) => f.kind === "workflow.step.uses" && (!job || \`\${f.attributes?.workflow}#\${f.attributes?.job}\` === job))
    .map((f) => resolveAction(repoPath, f.value, f.evidence));
  references.push(...serviceRefs, ...actionRefs);

  add("checkout", "checkout", ["git", "checkout", headSha], false, [], []);`,
);

// The pipeline now carries the reference graph and the hard optimisation boundary.
s = s.replace(
  `  return {
    schema: "diffci.ci.inference/v1",
    repository,
    headSha,
    facts,
    operations,
    unresolved,`,
  `  // THE HARD BOUNDARY. An incomplete causal execution path means a decision engine must not act on
  // this pipeline, however plausible the commands look.
  const nonExecutable = operations.filter((o) => !o.executable && o.kind !== "checkout");
  const optimisable = !refusal && nonExecutable.length === 0;
  const optimisationRefusal = optimisable
    ? undefined
    : refusal
      ? refusal.reason
      : \`\${nonExecutable.length} operation(s) are not executable: \${nonExecutable
          .map((o) => \`\${o.id} (\${[...o.missingRequirements, ...o.blockedBy].join(", ")})\`)
          .join("; ")}\`;

  return {
    schema: "diffci.ci.inference/v1",
    repository,
    headSha,
    facts,
    operations,
    unresolved,
    references,
    optimisable,
    ...(optimisationRefusal ? { optimisationRefusal } : {}),`,
);

writeFileSync(p, s);
console.log("infer.ts rewired: confidence and executability derived from the reference graph");
