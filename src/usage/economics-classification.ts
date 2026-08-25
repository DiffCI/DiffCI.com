/**
 * MEASURED / ESTIMATED / UNKNOWN - the external-shadow-pilot report vocabulary (2026-08-25, per explicit
 * direction: these are not marketing labels, they are mechanical rules over the existing economics
 * evidence types). Deliberately a thin projection of savings.ts's own, richer SavingsConfidence
 * (`measured | historical_estimate | count_based_estimate | unavailable`) - never a parallel vocabulary
 * invented from scratch. The internal 4-tier type is kept (it distinguishes TWO estimation methods,
 * useful for audit/debugging); the report only ever needs the collapsed 3-tier view.
 *
 * The rule that matters most (2026-08-25 correction, after the proposal's first draft implied a real
 * counterfactual execution could ever upgrade this): in PURE shadow mode, the counterfactual
 * (DiffCI-selected) side of an avoidable-opportunity figure is NEVER "measured" - shadow mode never
 * executes it to measure it, by the same zero-behavior-change guarantee that makes this a shadow pilot at
 * all. `combineForAvoidable` enforces this by construction: the combined tier is always the WEAKER of its
 * two inputs, never upgraded by pairing a strong side with a weak one.
 */
import type { SavingsConfidence, ValueWithConfidence } from "./savings.js";

export type EvidenceTier = "MEASURED" | "ESTIMATED" | "UNKNOWN";

const SAVINGS_CONFIDENCE_TO_TIER: Record<SavingsConfidence, EvidenceTier> = {
  measured: "MEASURED",
  historical_estimate: "ESTIMATED",
  count_based_estimate: "ESTIMATED",
  unavailable: "UNKNOWN",
};

/** Collapses savings.ts's own 4-tier confidence into the report-facing 3-tier vocabulary. Pure mapping,
 * no judgment calls - the actual honesty work happens wherever a SavingsConfidence value is first
 * produced (savings.ts, duration-capture.ts), not here. */
export function toEvidenceTier(confidence: SavingsConfidence): EvidenceTier {
  return SAVINGS_CONFIDENCE_TO_TIER[confidence];
}

const TIER_RANK: Record<EvidenceTier, number> = { MEASURED: 2, ESTIMATED: 1, UNKNOWN: 0 };

export interface AvoidableResult {
  /** Undefined whenever tier is UNKNOWN - never a fabricated 0 standing in for "couldn't compute". */
  value: number | undefined;
  tier: EvidenceTier;
}

/** The weakest-wins rule for a value derived from TWO independent measurements (e.g. avoidable = full -
 * selected). Never averages, never upgrades - the combined tier is the weaker of the two inputs' tiers,
 * always. A MEASURED full-workload figure paired with an ESTIMATED (or UNKNOWN) selected-workload figure
 * yields, at best, ESTIMATED avoidable opportunity - never MEASURED. */
export function combineForAvoidable(full: ValueWithConfidence<number>, selected: ValueWithConfidence<number>): AvoidableResult {
  if (typeof full.value !== "number" || typeof selected.value !== "number") return { value: undefined, tier: "UNKNOWN" };
  const fullTier = toEvidenceTier(full.confidence);
  const selectedTier = toEvidenceTier(selected.confidence);
  const weaker = TIER_RANK[fullTier] <= TIER_RANK[selectedTier] ? fullTier : selectedTier;
  if (weaker === "UNKNOWN") return { value: undefined, tier: "UNKNOWN" };
  return { value: Math.max(0, full.value - selected.value), tier: weaker };
}
