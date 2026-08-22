/**
 * Provider-independent compute cost estimation (Part 10). Never hard-codes AWS/GCP pricing throughout
 * the application - every caller goes through ComputeCostModel.estimateCost(), so swapping in real
 * provider pricing later touches one implementation, not every call site.
 */
export interface CostEstimateInput {
  computeSeconds: number;
}

export interface CostEstimate {
  estimatedUsd: number;
  /** Always "estimated" for this initial implementation - Part 10: "Clearly distinguish estimated cost
   * avoided from actual invoice savings." Nothing in this codebase yet produces a real invoice-backed
   * number; a future ComputeCostModel implementation backed by real provider billing data could return
   * "measured" instead, but must do so explicitly, never by silently reusing this type. */
  basis: "estimated";
  ratePerComputeSecondUsd: number;
}

export interface ComputeCostModel {
  readonly name: string;
  estimateCost(input: CostEstimateInput): CostEstimate;
}

/**
 * Placeholder/default rates (Part 10: "Initial implementation can support internal/mock/default cost
 * rates") - a rough, clearly-labeled approximation, not sourced from any specific provider's real
 * pricing page. Replace with a real provider-backed model before this number is shown to a customer as
 * anything stronger than an estimate.
 */
const DEFAULT_RATE_PER_COMPUTE_SECOND_USD = 0.00015; // ~ a small CI-runner-class instance, illustrative only

export function createDefaultComputeCostModel(ratePerComputeSecondUsd: number = DEFAULT_RATE_PER_COMPUTE_SECOND_USD): ComputeCostModel {
  return {
    name: "default-estimate",
    estimateCost({ computeSeconds }) {
      return { estimatedUsd: Math.max(0, computeSeconds) * ratePerComputeSecondUsd, basis: "estimated", ratePerComputeSecondUsd };
    },
  };
}
