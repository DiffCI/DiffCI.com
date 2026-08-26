/**
 * The shadow-economics counterfactual estimator (External Shadow Pilot M2, 2026-08-26).
 *
 * This module answers exactly one question: "if DiffCI had run only the tests it selected, how much of
 * this commit's REAL measured test time would it not have spent?" That is a PROJECTION, never an
 * observation - the selected subset is never independently executed in shadow mode, so the result is
 * ESTIMATED forever. Nothing here can produce a MEASURED tier, and the combineForAvoidable call below is
 * what structurally guarantees that (weakest-tier-wins), rather than a convention someone could forget.
 *
 * v1 (withdrawn) extrapolated from a CROSS-COMMIT historical seconds-per-test average. Live evidence
 * killed it: a plan_mode FULL commit selecting 70 of 70 tests was reported as avoiding 28 seconds,
 * because history said 0.5s/test while that commit's own 70 tests really took 63s. v1 was converting
 * test-suite run-to-run variance into DiffCI value. See the v2 migration for the full incident.
 *
 * v2 anchors to the commit's OWN measured workload and scales by the real selection ratio. FULL then
 * yields zero avoidable by construction rather than by special case.
 *
 * KNOWN LIMITATION, stated rather than hidden: this is a LINEAR-COST model. It assumes every test costs
 * the same and models NO fixed per-invocation overhead (container bootstrap, dependency install,
 * compilation). Real suites have a floor - Cal.com showed roughly a 20-second selected floor - so at small
 * selection ratios this OVERSTATES avoidable time. The honest refinement is
 *   selectedMs = fixedOverheadMs + (fullMs - fixedOverheadMs) * ratio
 * but fixedOverheadMs cannot be responsibly guessed; it needs real selected-run measurements from actual
 * telemetry. Deliberately not invented here.
 *
 * Estimated values are for opportunity discovery ONLY. They must never feed billing, activation
 * decisions, or any claim of realized savings.
 */
import { combineForAvoidable, type EvidenceTier } from "./economics-classification.js";
import type { SavingsConfidence, ValueWithConfidence } from "./savings.js";
import type { CiStage } from "../shadow/stage-classification.js";

/** Bump ONLY when the estimation maths changes. The recompute job upgrades every row below this. */
export const ESTIMATOR_VERSION = 2;

export interface StageEstimateInput {
  stage: CiStage;
  /** Real, measured consumption for this stage on this commit. Never estimated. */
  fullWorkloadMs: number;
  testsSelectedDiffci: number | undefined;
  testsTotalFull: number | undefined;
  planMode: "FULL" | "SELECTIVE" | undefined;
}

export interface StageEstimate {
  selectedWorkloadMs: number | undefined;
  selectedWorkloadConfidence: SavingsConfidence | undefined;
  avoidableMs: number | undefined;
  avoidableTier: EvidenceTier;
  estimationMethod: string | undefined;
}

/** The single honest "we cannot say" result - used for every refusal below rather than a guessed zero,
 * because a 0 would misreport "DiffCI knows there is nothing to avoid" when the truth is "DiffCI cannot
 * evaluate this at all". */
const UNKNOWN: StageEstimate = {
  selectedWorkloadMs: undefined,
  selectedWorkloadConfidence: undefined,
  avoidableMs: undefined,
  avoidableTier: "UNKNOWN",
  estimationMethod: undefined,
};

export function estimateStageEconomics(input: StageEstimateInput): StageEstimate {
  // The engine has no build/lint/typecheck/e2e selection concept, so the test-ratio model must NEVER be
  // applied to them - doing so would invent savings for stages DiffCI cannot even reason about.
  if (input.stage !== "test") return UNKNOWN;

  const { fullWorkloadMs, testsSelectedDiffci: selected, testsTotalFull: total } = input;

  // Refuse on absent / zero / non-finite / inconsistent inputs rather than estimating around them.
  if (!Number.isFinite(fullWorkloadMs) || fullWorkloadMs < 0) return UNKNOWN;
  if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) return UNKNOWN;
  if (typeof selected !== "number" || !Number.isFinite(selected) || selected < 0) return UNKNOWN;

  // A FULL plan executed everything; selecting >= the total is the same situation reached by counts
  // rather than by plan mode. Both must yield exactly zero avoidable - never a variance-driven number,
  // and never a negative one.
  const selectedEverything = input.planMode === "FULL" || selected >= total;
  const ratio = selectedEverything ? 1 : selected / total;

  // Clamp defensively: even with the guards above, the stored value must be provably within [0, full].
  const selectedMs = Math.min(fullWorkloadMs, Math.max(0, fullWorkloadMs * ratio));

  const full: ValueWithConfidence<number> = { value: fullWorkloadMs, confidence: "measured" };
  // count_based_estimate, not historical_estimate: this is derived from THIS commit's real workload and
  // real test counts, with no cross-commit history involved.
  const selectedValue: ValueWithConfidence<number> = { value: selectedMs, confidence: "count_based_estimate" };
  // Weakest-tier-wins: measured + count_based_estimate can only ever be ESTIMATED. This is the structural
  // guarantee that shadow mode never reports measured savings.
  const avoidable = combineForAvoidable(full, selectedValue);

  return {
    selectedWorkloadMs: selectedMs,
    selectedWorkloadConfidence: "count_based_estimate",
    avoidableMs: avoidable.value,
    avoidableTier: avoidable.tier,
    estimationMethod: `linear_within_commit_ratio_v${ESTIMATOR_VERSION}:${selected}/${total}`,
  };
}
