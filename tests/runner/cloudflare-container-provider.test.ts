import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCloudflareContainerRunnerProvider } from "../../src/runner/cloudflare-container-provider.js";

const CONFIG = { workerBaseUrl: "https://diffci-synthetic-runner.example.workers.dev", controlToken: "test-token", jobCommand: 'echo "diffci-runner-ok"' };

function fakeFetch(responses: Record<string, { status: number; body: unknown }>): typeof fetch {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const key = `${init?.method ?? "GET"} ${String(url)}`;
    const match = Object.entries(responses).find(([k]) => key.startsWith(k));
    if (!match) throw new Error(`Unmocked request: ${key}`);
    return new Response(JSON.stringify(match[1].body), { status: match[1].status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  (fn as unknown as { calls: typeof calls }).calls = calls;
  return fn;
}

describe("CloudflareContainerRunnerProvider - Part 16", () => {
  it("provisionRunner calls /v1/runner/execute with a Bearer control token and the job command, returns 'ready' with the real result attached", async () => {
    const fetchMock = fakeFetch({
      "POST https://diffci-synthetic-runner.example.workers.dev/v1/runner/execute": {
        status: 200,
        body: { ok: true, runnerId: "synth-x", result: { exitCode: 0, success: true, stdout: "diffci-runner-ok\n", stderr: "" }, timings: { provisionStartedAt: 1000, readyAt: 1010, completedAt: 1300, terminatedAt: 1320 } },
      },
    });
    const provider = createCloudflareContainerRunnerProvider(CONFIG, fetchMock);
    const instance = await provider.provisionRunner({ organizationId: "org_1", resourceClass: "standard-2" });

    assert.ok(instance.providerRunnerId.startsWith("synth-"));
    assert.equal(instance.status, "ready");
    assert.equal((instance.providerMetadata?.result as { exitCode: number }).exitCode, 0);
    assert.ok(instance.providerMetadata?.timings);

    const calls = (fetchMock as unknown as { calls: Array<{ init?: RequestInit }> }).calls;
    assert.equal((calls[0]?.init?.headers as Record<string, string>)?.Authorization, "Bearer test-token");
    const body = JSON.parse(String(calls[0]?.init?.body));
    assert.equal(body.jobCommand, 'echo "diffci-runner-ok"');
  });

  it("throws a clear error when the Worker responds non-2xx", async () => {
    const fetchMock = fakeFetch({ "POST https://diffci-synthetic-runner.example.workers.dev/v1/runner/execute": { status: 502, body: { ok: false, error: "sandbox exec failed" } } });
    const provider = createCloudflareContainerRunnerProvider(CONFIG, fetchMock);
    await assert.rejects(() => provider.provisionRunner({ organizationId: "org_1", resourceClass: "standard-2" }), /Cloudflare Containers execute failed/);
  });

  it("getRunnerStatus returns the cached result for a runner this provider instance already completed", async () => {
    const fetchMock = fakeFetch({
      "POST https://diffci-synthetic-runner.example.workers.dev/v1/runner/execute": {
        status: 200,
        body: { ok: true, runnerId: "synth-x", result: { exitCode: 0, success: true, stdout: "ok", stderr: "" }, timings: { provisionStartedAt: 1, readyAt: 2, completedAt: 3 } },
      },
    });
    const provider = createCloudflareContainerRunnerProvider(CONFIG, fetchMock);
    const instance = await provider.provisionRunner({ organizationId: "org_1", resourceClass: "standard-2" });
    const status = await provider.getRunnerStatus(instance.providerRunnerId);
    assert.equal(status.status, "ready");
  });

  it("getRunnerStatus for a never-provisioned id reports terminated rather than throwing", async () => {
    const provider = createCloudflareContainerRunnerProvider(CONFIG, fakeFetch({}));
    const status = await provider.getRunnerStatus("never-provisioned");
    assert.equal(status.status, "terminated");
  });

  it("terminateRunner is a safe no-op - the container is already torn down by the time provisionRunner resolves", async () => {
    const provider = createCloudflareContainerRunnerProvider(CONFIG, fakeFetch({}));
    await assert.doesNotReject(() => provider.terminateRunner("synth-anything"));
  });
});
