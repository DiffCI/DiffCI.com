/**
 * The reference graph — what an execution step DEPENDS ON in order to be reproducible.
 *
 * INFERENCE_01 stored unresolved things as strings and assigned confidence by hand. That let an
 * operation be labelled `OBSERVED` because a plausible command was seen, while the things the command
 * actually needs — a pinned package manager, a resolvable script, an expanded matrix, a running service
 * — were unknown. `eslint-plugin-vue` produced a confident `npm install` that was equivalent to the
 * generic derivation that had already failed.
 *
 * So references become NODES. Each carries its evidence, its resolution state and what it still needs,
 * and **confidence is computed from the graph** rather than chosen:
 *
 *   every reference RESOLVED            → the operation may be executed
 *   any reference UNRESOLVED/UNRESOLVABLE → the operation is reportable but NOT executable
 *
 * THE HARD BOUNDARY:
 *
 *     incomplete causal execution path  ⇒  REFUSE TO OPTIMISE
 *
 * The engine may still say what it believes the command probably is. A decision engine must not treat
 * that belief as an executable plan.
 */
import type { EvidenceRef } from "./schema.js";

export type ReferenceKind =
  /** `uses: ./.github/actions/x` — lives in the repository and can be read. */
  | "LOCAL_ACTION"
  /** `uses: owner/repo@ref` — a third-party action whose steps are not in this repository. */
  | "COMPOSITE_ACTION"
  /** `jobs.x.uses: ./.github/workflows/y.yml` — another workflow supplying the steps. */
  | "REUSABLE_WORKFLOW"
  /** `${{ matrix.* }}` — the concrete command depends on an expansion. */
  | "MATRIX_EXPANSION"
  /** `services:` — the step expects something listening that the graph must provide. */
  | "SERVICE"
  /** `npm run x` — resolves through package.json, possibly to another script or an opaque binary. */
  | "SCRIPT_REFERENCE"
  /** `${{ secrets.X }}`, `$VAR` — a value not present in the repository. */
  | "ENV_REFERENCE"
  /** The command itself, once everything above is settled. */
  | "EXECUTION_OPERATION";

export type Resolution =
  /** Fully known from repository evidence. */
  | "RESOLVED"
  /** Not known yet, and knowable in principle — a local file not read, a script not followed. */
  | "UNRESOLVED"
  /** Not knowable from repository evidence alone — a remote action, a secret, a runner resource. */
  | "UNRESOLVABLE";

export interface ReferenceNode {
  id: string;
  kind: ReferenceKind;
  /** What is referenced, verbatim: an action name, a script name, a variable. */
  identifier: string;
  resolution: Resolution;
  /** Why it is not RESOLVED. Absent when it is. */
  reason?: string;
  evidence: EvidenceRef[];
  /** Other node ids this one needs. */
  dependsOn: string[];
  /** Requirements this node knows it has not met. */
  unmet: string[];
}

/**
 * What an operation of each kind needs before it can be executed FAITHFULLY.
 *
 * Not a checklist for its own sake: every entry is a thing whose absence has produced, or could
 * produce, a run that looks like the repository's CI and is not.
 */
export const COMPLETENESS_REQUIREMENTS: Record<string, string[]> = {
  install: [
    // Without one, "install" is not reproducible: the same command resolves differently over time,
    // which is exactly how eslint-plugin-vue's generic `npm install` crashed.
    "a pinned dependency basis (lockfile or packageManager field)",
    "a resolved package manager",
    "a known working directory",
  ],
  test: ["a resolved command", "a known working directory", "all referenced scripts resolved"],
  build: ["a resolved command", "a known working directory", "all referenced scripts resolved"],
  default: ["a resolved command", "a known working directory"],
};

export interface Completeness {
  /** Requirements met, by name. */
  satisfied: string[];
  /** Requirements NOT met, by name. Non-empty means not executable. */
  missing: string[];
  /** Reference nodes blocking this operation. */
  blockedBy: ReferenceNode[];
  /** Derived, never assigned: complete AND every reference resolved. */
  executable: boolean;
}

/**
 * Computes completeness for one operation from its reference nodes.
 *
 * `executable` is the only thing a decision engine may act on. `missing` and `blockedBy` are what a
 * human — or a future model — reads to understand WHY, which a boolean cannot carry.
 */
export function computeCompleteness(kind: string, requirementsMet: Record<string, boolean>, references: ReferenceNode[]): Completeness {
  const required = COMPLETENESS_REQUIREMENTS[kind] ?? COMPLETENESS_REQUIREMENTS.default!;
  const satisfied = required.filter((r) => requirementsMet[r] === true);
  const missing = required.filter((r) => requirementsMet[r] !== true);
  const blockedBy = references.filter((n) => n.resolution !== "RESOLVED");
  return { satisfied, missing, blockedBy, executable: missing.length === 0 && blockedBy.length === 0 };
}

/**
 * Confidence DERIVED from completeness. Never hand-assigned.
 *
 * `OBSERVED` now means more than "we saw this text": the command was seen AND everything it depends on
 * is resolved. That is the distinction INFERENCE_01 could not express, and it is why a plausible-looking
 * command could be labelled with the highest confidence available.
 */
export function confidenceFromCompleteness(sawVerbatim: boolean, completeness: Completeness): "OBSERVED" | "DERIVED" | "ASSUMED" {
  if (sawVerbatim && completeness.executable) return "OBSERVED";
  if (sawVerbatim || completeness.missing.length < (COMPLETENESS_REQUIREMENTS.default?.length ?? 2)) return "DERIVED";
  return "ASSUMED";
}
