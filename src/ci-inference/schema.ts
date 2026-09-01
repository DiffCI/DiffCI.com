/**
 * CI configuration inference — the evidence and learning schema.
 *
 * THE ONE INVARIANT THIS FILE EXISTS FOR: an OBSERVED FACT and an INFERENCE drawn from it are different
 * kinds of thing and are never stored in the same shape.
 *
 * A workflow line saying `npm ci` is a fact — it is in the file, at a path, at a line. "npm ci is this
 * repository's canonical install command" is an inference, derived from that fact by a named rule, and it
 * can be wrong while the fact stays true. Generation C's whole defect history is the cost of blurring
 * that: a derived command was recorded as though it were the repository's own, and when it failed the
 * failure was nearly attributed to the repository.
 *
 * This matters most for the training substrate. A model trained on rows where "what we saw" and "what we
 * concluded" are indistinguishable learns to reproduce our conclusions, including our mistakes, with no
 * way to re-derive them from evidence. Retrofitting the distinction later is impossible — the evidence is
 * gone by then.
 *
 * THE REPRESENTATION IS AN EXECUTION GRAPH, NOT A COMMAND LIST. Even where V1 understands only
 * install/build/test, the shape must grow into:
 *
 *   checkout → install → generate → lint → typecheck → build → test → security → package → deploy → verify
 *
 * A command list would have to be torn apart to get there, and every consumer rewritten with it.
 */

/** Where a fact was observed. A fact without a location cannot be re-checked. */
export interface EvidenceRef {
  /** Repo-relative path. */
  file: string;
  /** 1-indexed line, when the fact came from a line rather than a whole file. */
  line?: number;
  /** The literal text observed, trimmed. Never a paraphrase. */
  text: string;
}

/**
 * Something READ from the repository. Not a conclusion.
 *
 * `kind` names what was read, not what it means: `workflow.step.run` is a fact about a YAML file;
 * whether that step is the canonical install is an inference.
 */
export interface ObservedFact {
  kind:
    | "workflow.job"
    | "workflow.step.run"
    | "workflow.step.uses"
    | "workflow.matrix"
    | "workflow.env"
    | "workflow.services"
    | "package.script"
    | "package.packageManager"
    | "package.engines"
    | "package.dependency"
    | "lockfile.present"
    | "nodeVersionFile"
    | "runnerConfig";
  value: string;
  evidence: EvidenceRef;
  /** Free-form detail that stays DATA — e.g. the job id a step belongs to. */
  attributes?: Record<string, string>;
}

/** The operations a pipeline can contain. Deliberately wider than V1 understands. */
export type OperationKind =
  | "checkout"
  | "setup-runtime"
  | "install"
  | "generate"
  | "lint"
  | "typecheck"
  | "build"
  | "test"
  | "security"
  | "package"
  | "deploy"
  | "verify"
  | "unknown";

/**
 * How much the inference engine trusts one inferred operation.
 *
 * `OBSERVED` is reserved for an operation lifted VERBATIM from a workflow the repository runs in CI —
 * the strongest evidence available without executing anything. `DERIVED` means a rule produced it from
 * facts. `ASSUMED` means a default filled a gap, and is the level at which Generation C's failures all
 * happened.
 */
export type Confidence = "OBSERVED" | "DERIVED" | "ASSUMED";

/** Something the engine could not resolve. Kept, never silently dropped. */
export interface Unresolved {
  what: string;
  why: string;
  evidence?: EvidenceRef;
}

/**
 * One node of the execution graph.
 *
 * `evidence` is the list of facts this operation was inferred FROM, so a reader can re-derive the
 * conclusion rather than trust it. An operation with `confidence: "OBSERVED"` and an empty evidence list
 * is a contradiction, and `validateOperation` rejects it.
 */
export interface InferredOperation {
  id: string;
  kind: OperationKind;
  /** argv, never a shell string, so it cannot be re-split differently later. */
  command: string[];
  workingDirectory: string;
  /** Runtime the step needs, when the repository declares one. */
  runtime?: { name: "node" | "other"; version?: string; source: EvidenceRef };
  /** Environment the repository sets for this operation. */
  environment: Record<string, string>;
  /** Operation ids that must complete first. */
  dependsOn: string[];
  evidence: EvidenceRef[];
  confidence: Confidence;
  unresolved: Unresolved[];
  /** Present ONLY when the engine declines to propose this operation. */
  refusalReason?: string;
}

/**
 * The inferred pipeline for one repository at one tree.
 *
 * `facts` is everything observed; `operations` is everything concluded. The separation is the point.
 */
export interface InferredPipeline {
  schema: "diffci.ci.inference/v1";
  repository: string;
  headSha: string;
  facts: ObservedFact[];
  operations: InferredOperation[];
  unresolved: Unresolved[];
  /**
   * The engine declines to describe this pipeline at all.
   *
   * A refusal is a RESULT, not a failure: an optimiser that cannot tell when it does not understand a
   * pipeline is more dangerous than one that says so.
   */
  refusal?: { reason: string; evidence: EvidenceRef[] };
  producedAt: string;
}

/**
 * One benchmark row: the old generic derivation, the new inference, and what actually happened.
 *
 * This is the training row shape. It is written even when the inference refuses, because a refusal that
 * would have prevented a known failure is a correct outcome and must be learnable as one.
 */
export interface InferenceBenchmarkRow {
  schema: "diffci.ci.inference.benchmark/v1";
  repository: string;
  headSha: string;
  /** What E2 registration derived generically, and what it produced. */
  genericDerivation: { install: string[]; build?: string[]; testModule?: string; testArgs?: string[] };
  knownFailure: { stage: string; detail: string };
  /** What the inference engine says, from repository evidence alone. */
  inferred: InferredPipeline;
  /** Whether the inference would have avoided the known failure — see `BenchmarkVerdict`. */
  verdict: BenchmarkVerdict;
  verdictReason: string;
}

/**
 * How an inference is scored against a known failure.
 *
 * CORRECT_REFUSAL is scored as a SUCCESS. The engine must know when it does not understand a pipeline
 * well enough to optimise it, and saying so is more valuable than a confident wrong plan.
 */
export type BenchmarkVerdict =
  /** The inferred plan differs from the generic one in the way that would have avoided the failure. */
  | "CORRECT_INFERENCE"
  /** The engine refused, and the refusal would have prevented the failure. */
  | "CORRECT_REFUSAL"
  /** The engine could not resolve enough to say anything, and says so. Not a wrong answer. */
  | "INSUFFICIENT_EVIDENCE"
  /** The engine produced a confident plan that would still have failed, or failed differently. */
  | "INCORRECT_INFERENCE";

/** Structural checks that must hold for any operation the engine emits. */
export function validateOperation(op: InferredOperation): string[] {
  const problems: string[] = [];
  if (op.confidence === "OBSERVED" && op.evidence.length === 0) {
    problems.push(`${op.id}: OBSERVED confidence with no evidence - a conclusion presented as an observation`);
  }
  if (op.command.length === 0 && !op.refusalReason) {
    problems.push(`${op.id}: empty command with no refusal reason`);
  }
  if (op.refusalReason && op.command.length > 0) {
    problems.push(`${op.id}: refused but still proposes a command`);
  }
  return problems;
}
