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
  /** "estimated" - an illustrative, not-provider-sourced placeholder rate (createDefaultComputeCostModel).
   * "provider_estimate" - computed from a real provider's own published pricing for a specific instance
   * shape (R1 Part 23/24 - createCloudflareContainersLiteCostModel), still not an actual invoice line
   * (Cloudflare's real bill may round/batch differently), but a genuine rate, not a guess.
   * Nothing in this codebase yet produces a real invoice-backed number ("measured") - a future
   * ComputeCostModel backed by real provider billing data could return that, but must do so explicitly,
   * never by silently reusing either of the above. */
  basis: "estimated" | "provider_estimate";
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

/**
 * Real Cloudflare Containers pricing for the "lite" instance shape (R1 Part 4/23) - the exact same
 * numbers already sourced and used in scripts/live-synthetic-runner-proof.ts (2026-08-22, from
 * docs.cloudflare.com/containers/pricing), formalized here as a real, reusable ComputeCostModel so R1's
 * real runner completions can persist a real Runner.costEstimateUsd (audit finding: this never happens
 * in any production code path today) instead of only computing it in a throwaway script.
 *
 * Cloudflare bills container compute per vCPU-second and per GiB-second of memory. "lite" is 0.25 vCPU
 * (250 millicores) / 256 MiB. This rate is a real, provider-sourced number, not an invented placeholder
 * - but it is still an ESTIMATE, not an actual invoice line (Cloudflare's real bill may round/batch
 * differently, and rates are subject to change) - hence `basis: "provider_estimate"`, never "measured".
 */
const CLOUDFLARE_CONTAINERS_LITE_PRICING = {
  instanceType: "lite",
  vcpuSecondUsd: 0.00002,
  gibSecondUsd: 0.0000025,
  vcpuMilli: 250,
  memoryMiB: 256,
  sourceNote: "Cloudflare Containers published pricing (docs.cloudflare.com/containers/pricing), referenced 2026-08-22",
} as const;

export function createCloudflareContainersLiteCostModel(): ComputeCostModel {
  const { vcpuMilli, memoryMiB, vcpuSecondUsd, gibSecondUsd } = CLOUDFLARE_CONTAINERS_LITE_PRICING;
  const vcpuFraction = vcpuMilli / 1000;
  const gibFraction = memoryMiB / 1024;
  const ratePerComputeSecondUsd = vcpuFraction * vcpuSecondUsd + gibFraction * gibSecondUsd;
  return {
    name: "cloudflare-containers-lite",
    estimateCost({ computeSeconds }) {
      const seconds = Math.max(0, computeSeconds);
      const estimatedUsd = seconds * vcpuFraction * vcpuSecondUsd + seconds * gibFraction * gibSecondUsd;
      return { estimatedUsd, basis: "provider_estimate", ratePerComputeSecondUsd };
    },
  };
}

export { CLOUDFLARE_CONTAINERS_LITE_PRICING };
