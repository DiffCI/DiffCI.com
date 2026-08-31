/**
 * The execution receipt — one provenance record, identical in shape for every mode.
 *
 * THE INVARIANT: no DiffCI decision without an execution receipt.
 *
 * Defects 17–20 all shared a shape: a control was DECLARED and its execution was assumed. Defect 19 is
 * the pure case — `requiresApparatus: "gen-c"` was correct code sitting where three of the six modes
 * returned before reaching it, so the guard was reported as protection by the job definition, by the
 * documentation and by me, while never running. No amount of testing the guard's own logic could have
 * found that; only asking "did it execute?" can.
 *
 * So a receipt records what ACTUALLY HAPPENED, not what was configured:
 *
 *   - `guard.executed` is false unless the guard ran. A declared-but-unreached control is visible as
 *     `declared: true, executed: false`, which is the exact state defect 19 occupied silently.
 *   - `apparatus` carries the values the guard COMPARED, not a restatement of the job's expectations,
 *     so a reader can re-derive the verdict instead of trusting it.
 *
 * Every mode emits the same core identity — survey, calibration, qualification, observation, mutation —
 * so provenance semantics do not change with the mode. That matters beyond this experiment: when DiffCI
 * eventually tells a customer's CI to skip 19 jobs, the evidence needed is not only the decision but
 * which analyser, which policy, which guards actually executed, in which environment. The same record
 * becomes a training example:
 *
 *   inputs → model/version → proposed plan → guards actually executed → resulting plan →
 *   actual execution → outcome → cost
 *
 * This file is that record's first form. It is deliberately mode-agnostic.
 */

/**
 * THE CAUSALITY INVARIANT.
 *
 *     repository outcome  ≠  execution infrastructure outcome
 *
 * A run can fail for reasons that say NOTHING about the repository: the registry had no entry for it
 * (an apparatus gap), a fact file was unreadable through a rank-width assumption (defect 21), a lookup
 * used the wrong filename separator (my error), or the container platform stopped mid-bootstrap. On
 * 2026-08-31 one repository accumulated THREE consecutive bootstrap failures, and a known-good
 * apparatus job then failed identically — proving the fault was never the repository.
 *
 * Every one of those, recorded as "this repository failed", would have removed an eligible repository
 * from a population for a reason with no substance.
 *
 * This matters far past one experiment. A learning system trained on these records must never conclude
 * "this repository is unsafe" or "this work was unnecessary" from a runner or platform failure. Such
 * rows are either labelled as infrastructure and excluded from impact-model training, or they teach the
 * model something false about the code.
 *
 * So an outcome carries WHERE it happened. A failure before the repository's own install is
 * infrastructure by construction: none of the repository had run yet.
 *
 * Preserve causality before accumulating data.
 */
export type OutcomeLayer =
  /** Platform, container, harness, registry — nothing about the repository was exercised. */
  | "INFRASTRUCTURE"
  /** The repository's own install, build or test suite produced the outcome. */
  | "REPOSITORY"
  /** The analyser produced the outcome. */
  | "ANALYSER";

/**
 * Steps that run before any repository code executes. A failure at one of these is INFRASTRUCTURE by
 * construction, not a judgement about the repository.
 */
const PRE_REPOSITORY_STEPS: ReadonlySet<string> = new Set(["bootstrapping", "preparing", "verifyingUniverse", "registering"]);

/**
 * Which layer an outcome belongs to.
 *
 * Structural rather than heuristic: it asks whether the run had reached the repository's own execution,
 * not what the error message said.
 */
export function outcomeLayer(step: string, failed: boolean): OutcomeLayer {
  if (!failed) return "REPOSITORY";
  return PRE_REPOSITORY_STEPS.has(step) ? "INFRASTRUCTURE" : "REPOSITORY";
}

export interface ApparatusIdentityRecord {
  agentIntegrity?: string;
  image?: string;
  node?: string;
  npm?: string;
  git?: string;
  osRelease?: string;
  sourceTarballKey?: string;
  sourceTarballSha256?: string;
}

export interface GuardRecord {
  /** The job asked for this control. */
  declared: boolean;
  /**
   * The control RAN. False with `declared: true` is defect 19's exact state, and is the reason this
   * field exists separately from `declared` rather than being inferred from it.
   */
  executed: boolean;
  /** Which control. */
  name: string;
  /** PASS, FAIL, or NOT_REACHED. */
  result: "PASS" | "FAIL" | "NOT_REACHED";
  /** Every mismatch found, empty on PASS. */
  problems: string[];
}

export interface ExecutionReceipt {
  receiptVersion: 1;
  runId: string;
  jobId: string;
  mode: string;
  shardIndex: number;
  /** The values the guards actually compared. A reader re-derives the verdict rather than trusting it. */
  apparatus: ApparatusIdentityRecord;
  /** Every control the run declares, with whether it ran. */
  guards: GuardRecord[];
  /** Allowlisted harness passes actually executed, in order, with their exit status. */
  commands: Array<{ label: string; argv: string[]; exitStatus: number | null }>;
  timings: Record<string, number>;
  outcome: { step: string; failed: boolean; layer: OutcomeLayer; errorClass?: string; error?: string };
  producedAt: string;
}

export interface ReceiptSource {
  runId: string;
  jobId: string;
  mode: string;
  shardIndex: number;
  environment?: ApparatusIdentityRecord;
  sourceTarballKey?: string;
  sourceTarballSha256?: string;
  guards?: GuardRecord[];
  commands?: Array<{ label: string; argv: string[]; exitStatus: number | null }>;
  timings?: Record<string, number>;
  step: string;
  /** The step the run was on when it failed. This, not the error text, decides the layer. */
  stepBeforeFailure?: string;
  errorClass?: string;
  error?: string;
}

/**
 * Builds the receipt.
 *
 * A run that declared no guard still gets a receipt with an empty `guards` array — the absence of a
 * control is itself provenance, and inventing a passing entry would defeat the purpose.
 */
export function buildExecutionReceipt(source: ReceiptSource, producedAt: string): ExecutionReceipt {
  return {
    receiptVersion: 1,
    runId: source.runId,
    jobId: source.jobId,
    mode: source.mode,
    shardIndex: source.shardIndex,
    apparatus: {
      ...(source.environment ?? {}),
      sourceTarballKey: source.sourceTarballKey,
      sourceTarballSha256: source.sourceTarballSha256,
    },
    guards: source.guards ?? [],
    commands: source.commands ?? [],
    timings: source.timings ?? {},
    outcome: {
      step: source.step,
      failed: source.step === "failed",
      // Recorded, never re-derived later. A reader - or a training pipeline - must be able to exclude
      // infrastructure failures without parsing an error string to guess where the run died.
      layer: outcomeLayer(source.stepBeforeFailure ?? source.step, source.step === "failed"),
      errorClass: source.errorClass,
      error: source.error,
    },
    producedAt,
  };
}

/**
 * Reasons a receipt does not attest to a sound run. Empty means it does.
 *
 * Used by readers of evidence, not only by the producer: a receipt whose guard declared but did not
 * execute must not be quietly accepted just because the run completed.
 */
export function receiptProblems(receipt: ExecutionReceipt): string[] {
  const problems: string[] = [];
  for (const guard of receipt.guards) {
    if (guard.declared && !guard.executed) {
      problems.push(`guard "${guard.name}" was DECLARED but never EXECUTED - this is the defect-19 state`);
    }
    if (guard.executed && guard.result === "FAIL") {
      problems.push(`guard "${guard.name}" FAILED: ${guard.problems.join("; ")}`);
    }
  }
  if (!receipt.apparatus.agentIntegrity) problems.push("no agent digest recorded, so the analyser under test is unidentified");
  return problems;
}
