/**
 * Provider-independent carbon-avoided estimation, the direct climate-impact sibling of
 * src/usage/cost-model.ts - same shape (a swappable model interface, one call site per estimate,
 * never a hard-coded rate scattered through callers), applied to CO2e instead of USD.
 *
 * Honesty note that does NOT apply to cost-model.ts: unlike compute pricing, no cloud provider -
 * Cloudflare included - publishes real per-instance power draw or carbon-intensity figures for its
 * compute. There is therefore no "provider_estimate" tier here the way createCloudflareContainersLiteCostModel
 * has one; every CarbonEstimate this module can produce is `basis: "estimated"` - a real avoided-compute-
 * seconds count (see src/usage/savings.ts) combined with published, industry-standard *methodology*
 * (Cloud Carbon Footprint-style average power-draw coefficients: https://www.cloudcarbonfootprint.org/docs/methodology)
 * and a global-average grid carbon-intensity figure (~IEA average), not a measurement of any real DiffCI
 * runner's actual power draw or its actual electricity source. Never present this as more certain than
 * that to a customer.
 */
import { CLOUDFLARE_CONTAINERS_LITE_PRICING } from "./cost-model.js";

export interface CarbonEstimateInput {
  computeSeconds: number;
}

export interface CarbonEstimate {
  estimatedKgCo2e: number;
  /** Always "estimated" today - see the module-level note above for why no stronger tier exists yet. */
  basis: "estimated";
  ratePerComputeSecondKgCo2e: number;
}

export interface ClimateImpactModel {
  readonly name: string;
  estimateCarbon(input: CarbonEstimateInput): CarbonEstimate;
}

/**
 * Illustrative average power-draw coefficients, loosely following the Cloud Carbon Footprint project's
 * published methodology for estimating cloud compute energy use from vCPU/memory allocation when a
 * provider does not expose real per-instance power telemetry. Not measured for any specific DiffCI
 * runner or provider.
 */
const DEFAULT_WATTS_PER_VCPU = 5; // average watts per vCPU under typical CI-job load
const DEFAULT_WATTS_PER_GIB_MEMORY = 0.392; // average watts per GiB of allocated memory

/** Global average electricity grid carbon intensity, illustrative (~IEA World Energy Outlook global
 * average order of magnitude). A real deployment should replace this with the actual grid intensity for
 * wherever the compute provider's datacenter draws power, which DiffCI does not currently know. */
const DEFAULT_GRID_CARBON_INTENSITY_G_CO2E_PER_KWH = 475;

function ratePerComputeSecondKgCo2e(vcpuFraction: number, gibFraction: number, gridIntensityGPerKwh: number): number {
  const watts = vcpuFraction * DEFAULT_WATTS_PER_VCPU + gibFraction * DEFAULT_WATTS_PER_GIB_MEMORY;
  const kWhPerSecond = watts / 1000 / 3600;
  const gCo2ePerSecond = kWhPerSecond * gridIntensityGPerKwh;
  return gCo2ePerSecond / 1000; // g -> kg
}

/**
 * A generic default shape (1 full vCPU, 1 GiB memory) for callers with no specific instance shape in
 * mind - mirrors createDefaultComputeCostModel's role as an illustrative, swappable placeholder.
 */
export function createDefaultClimateImpactModel(gridCarbonIntensityGCo2ePerKwh: number = DEFAULT_GRID_CARBON_INTENSITY_G_CO2E_PER_KWH): ClimateImpactModel {
  const rate = ratePerComputeSecondKgCo2e(1, 1, gridCarbonIntensityGCo2ePerKwh);
  return {
    name: "default-estimate",
    estimateCarbon({ computeSeconds }) {
      return { estimatedKgCo2e: Math.max(0, computeSeconds) * rate, basis: "estimated", ratePerComputeSecondKgCo2e: rate };
    },
  };
}

/**
 * Shaped after Cloudflare's real, published "lite" instance dimensions (0.25 vCPU / 256 MiB - see
 * CLOUDFLARE_CONTAINERS_LITE_PRICING, the exact same shape createCloudflareContainersLiteCostModel uses),
 * combined with the same illustrative power/grid coefficients as createDefaultClimateImpactModel. The
 * instance shape is real; the power-draw and grid-intensity numbers are not - hence `basis: "estimated"`,
 * never a stronger tier, even though this is the shape DiffCI's real runners actually use.
 */
export function createCloudflareContainersLiteClimateModel(gridCarbonIntensityGCo2ePerKwh: number = DEFAULT_GRID_CARBON_INTENSITY_G_CO2E_PER_KWH): ClimateImpactModel {
  const { vcpuMilli, memoryMiB } = CLOUDFLARE_CONTAINERS_LITE_PRICING;
  const vcpuFraction = vcpuMilli / 1000;
  const gibFraction = memoryMiB / 1024;
  const rate = ratePerComputeSecondKgCo2e(vcpuFraction, gibFraction, gridCarbonIntensityGCo2ePerKwh);
  return {
    name: "cloudflare-containers-lite-estimate",
    estimateCarbon({ computeSeconds }) {
      return { estimatedKgCo2e: Math.max(0, computeSeconds) * rate, basis: "estimated", ratePerComputeSecondKgCo2e: rate };
    },
  };
}
