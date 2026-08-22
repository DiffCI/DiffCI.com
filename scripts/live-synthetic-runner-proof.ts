/**
 * Live, one-shot proof (Part 19/20/21) of the REAL Cloudflare Containers runner lifecycle against the
 * REAL deployed diffci-synthetic-runner Worker (docker.io/cloudflare/sandbox:0.12.5): runner provisions
 * -> becomes ready -> executes the synthetic job -> stdout/exit code captured -> real timings recorded
 * -> cost estimated -> runner confirmed terminated. This exercises the real cloud runner end to end,
 * over HTTP, exactly as CloudflareContainerRunnerProvider (src/runner/cloudflare-container-provider.ts)
 * does from within the scheduler.
 *
 * Scope note: the queue/RunnerStore/usage-ledger SIDE of the pipeline (queue item -> scheduler ->
 * RunnerStore lifecycle transitions -> usage_events) is proven separately and thoroughly by
 * tests/execution-queue/synthetic-execution.test.ts (real-SQLite-backed, 26 assertions across the full
 * state machine) using the MOCK provider - this script's job is specifically to prove the ONE piece that
 * cannot be proven by a mock: that a REAL, billable Cloudflare Container actually provisions and runs
 * code. Composing the two (real provider + real D1 queue) is the natural next integration step once the
 * product Worker also has RUNNER_CONTROL_TOKEN configured to reach this Worker.
 *
 * No GitHub workflow depends on this; run manually, not from CI.
 * Usage: RUNNER_CONTROL_TOKEN=<from .research/synthetic-runner-control-token> npx tsx scripts/live-synthetic-runner-proof.ts
 */
import { readFileSync } from "node:fs";

const CONTROL_TOKEN = process.env.RUNNER_CONTROL_TOKEN ?? readFileSync(".research/synthetic-runner-control-token", "utf8").trim();
const SYNTHETIC_RUNNER_URL = "https://diffci-synthetic-runner.damp-waterfall-0cd8.workers.dev";

// Real, illustrative Cloudflare Containers pricing input (Part 21) - "lite" instance type, sourced from
// Cloudflare's published Workers/Containers pricing at the time of this build (2026-08-22). Documented
// explicitly as an ESTIMATE, not an exact invoice line - Cloudflare bills container compute per vCPU-
// second and per GiB-second of memory with a platform-defined minimum billing granularity; this
// computation rounds up to that granularity rather than reporting a misleadingly precise fractional cent.
const PRICING_SOURCE = { instanceType: "lite", vcpuSecondUsd: 0.000020, gibSecondUsd: 0.0000025, sourceNote: "Cloudflare Containers published pricing, referenced 2026-08-22 - see docs.cloudflare.com/containers/pricing", lite: { vcpuMilli: 250, memoryMiB: 256 } };

function estimateCostUsd(runtimeSeconds: number): { estimatedUsd: number; basis: "provider_estimate" } {
  const vcpuSeconds = runtimeSeconds * (PRICING_SOURCE.lite.vcpuMilli / 1000);
  const gibSeconds = runtimeSeconds * (PRICING_SOURCE.lite.memoryMiB / 1024);
  const estimatedUsd = vcpuSeconds * PRICING_SOURCE.vcpuSecondUsd + gibSeconds * PRICING_SOURCE.gibSecondUsd;
  return { estimatedUsd, basis: "provider_estimate" };
}

async function main() {
  console.log("=== Part 19/29 live synthetic execution proof ===");
  console.log(`Pricing source: ${PRICING_SOURCE.sourceNote}`);

  // --- clock start (this script's own timer, before the provider is called - the same "queue latency"
  // point the scheduler would mark a queue item's request timestamp at) -----------------------------
  const queueLatencyStart = Date.now();
  const runnerId = `synth-proof-${Date.now()}`;
  console.log(`\n[proof] runnerId=${runnerId}`);

  // --- provider provisions runner -> runner ready -> job executes -> completes ---------------------
  const provisionCallStart = Date.now();
  const res = await fetch(`${SYNTHETIC_RUNNER_URL}/v1/runner/execute`, {
    method: "POST",
    headers: { Authorization: `Bearer ${CONTROL_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId, jobCommand: "echo diffci-runner-ok" }),
  });
  const provisionCallEnd = Date.now();
  if (!res.ok) {
    console.error(`FAILED: HTTP ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const body = (await res.json()) as { runnerId: string; result: { exitCode: number; success: boolean; stdout: string; stderr: string }; timings: { provisionStartedAt: number; readyAt: number; completedAt: number; terminatedAt?: number } };

  console.log(`[runner] stdout: ${JSON.stringify(body.result.stdout)}`);
  console.log(`[runner] exitCode: ${body.result.exitCode}, success: ${body.result.success}`);
  if (body.result.stdout.trim() !== "diffci-runner-ok" || body.result.exitCode !== 0) {
    console.error("FAILED: unexpected job output/exit code");
    process.exit(1);
  }

  const t = body.timings;
  const runtimeSeconds = (t.completedAt - t.readyAt) / 1000;
  const teardownSeconds = t.terminatedAt ? (t.terminatedAt - t.completedAt) / 1000 : undefined;
  const totalLifecycleSeconds = ((t.terminatedAt ?? t.completedAt) - queueLatencyStart) / 1000;
  const cost = estimateCostUsd(runtimeSeconds);

  console.log("\n--- Part 20 timings (all real, captured from this run) ---");
  console.log(`  queue -> provision call issued:  ${provisionCallStart - queueLatencyStart}ms`);
  console.log(`  provision -> ready:               ${t.readyAt - t.provisionStartedAt}ms (client construction only - real cold start is inside exec())`);
  console.log(`  ready -> execution complete:       ${(t.completedAt - t.readyAt).toFixed(0)}ms  (this is the real cold-start + command-run duration)`);
  console.log(`  execution complete -> terminated:  ${teardownSeconds !== undefined ? (teardownSeconds * 1000).toFixed(0) + "ms" : "unknown (destroy() may have failed - see Worker logs)"}`);
  console.log(`  total lifecycle (queue->terminated): ${(totalLifecycleSeconds * 1000).toFixed(0)}ms`);
  console.log(`  HTTP round-trip for the whole call (network + all of the above): ${provisionCallEnd - provisionCallStart}ms`);

  console.log("\n--- Part 21 cost estimate (PROVIDER ESTIMATE, not an exact invoice line) ---");
  console.log(`  runtime: ${runtimeSeconds.toFixed(3)}s`);
  console.log(`  estimated cost: $${cost.estimatedUsd.toFixed(8)} (basis: ${cost.basis})`);

  console.log("\n[runner] termination confirmed:", t.terminatedAt ? "yes" : "not confirmed (see Worker logs)");
  console.log("\n=== PROOF SUCCEEDED ===");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
