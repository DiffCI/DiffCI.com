/**
 * Deterministic mock/local RunnerProvider (Part 12: "a deterministic mock/local provider suitable for
 * lifecycle testing... The primary purpose is validating the orchestration model. Multi-cloud comes
 * later."). Deliberately simple: provisionRunner immediately succeeds and reports "ready" on the very
 * next status check (no artificial async delay/polling loop) - the ORCHESTRATION model (queue -> runner
 * store -> lifecycle transitions) is what's under test when this provider is used, not provider-specific
 * async provisioning latency, which a real cloud provider implementation would have and this one
 * deliberately does not simulate.
 */
import type { RunnerProvider } from "./provider.js";
import type { RunnerInstance, RunnerRequest, RunnerStatusResult } from "./types.js";

interface MockRunnerRecord {
  status: "ready" | "terminated";
  request: RunnerRequest;
}

export function createMockRunnerProvider(): RunnerProvider & { readonly runners: ReadonlyMap<string, MockRunnerRecord> } {
  const runners = new Map<string, MockRunnerRecord>();

  return {
    name: "mock",
    runners,

    async provisionRunner(request: RunnerRequest): Promise<RunnerInstance> {
      const providerRunnerId = `mock-${crypto.randomUUID()}`;
      runners.set(providerRunnerId, { status: "ready", request });
      return { providerRunnerId, status: "ready", providerMetadata: { mock: true, resourceClass: request.resourceClass } };
    },

    async getRunnerStatus(providerRunnerId: string): Promise<RunnerStatusResult> {
      const record = runners.get(providerRunnerId);
      if (!record) return { status: "terminated" }; // unknown id treated as already gone, never throws
      return { status: record.status, providerMetadata: { mock: true } };
    },

    async terminateRunner(providerRunnerId: string): Promise<void> {
      const record = runners.get(providerRunnerId);
      if (record) record.status = "terminated"; // idempotent: terminating an unknown/already-gone id is a silent no-op, never throws
    },
  };
}
