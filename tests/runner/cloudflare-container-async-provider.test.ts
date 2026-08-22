import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCloudflareContainerAsyncRunnerProvider } from "../../src/runner/cloudflare-container-async-provider.js";
import type { RunnerRequest } from "../../src/runner/types.js";

function baseRequest(): RunnerRequest {
  return {
    organizationId: "org-1",
    resourceClass: "lite",
    runnerCredential: { runnerId: "runner-abc", jobId: "job-1", token: "raw-token", apiBaseUrl: "https://product.example/api" },
    jobCommand: 'node -e "console.log(\'diffci-runner-ok\')"',
  };
}

function fakeFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const { status, body } = handler(url, init!);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

describe("createCloudflareContainerAsyncRunnerProvider - Part 7 real provider implementation", () => {
  it("provisionRunner() requires a runnerCredential and jobCommand - throws a clear error otherwise", async () => {
    const provider = createCloudflareContainerAsyncRunnerProvider({ workerBaseUrl: "https://x", controlToken: "t" }, fakeFetch(() => ({ status: 200, body: { ok: true } })));
    await assert.rejects(() => provider.provisionRunner({ organizationId: "org-1", resourceClass: "lite" }), /runnerCredential/);
  });

  it("provisionRunner() calls /v1/runner/start with the right auth and payload, returns status 'provisioning' immediately", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const provider = createCloudflareContainerAsyncRunnerProvider(
      { workerBaseUrl: "https://synthetic.example", controlToken: "control-token" },
      fakeFetch((url, init) => {
        calls.push({ url, body: JSON.parse(init.body as string) });
        return { status: 200, body: { ok: true, accepted: true } };
      }),
    );
    const instance = await provider.provisionRunner(baseRequest());
    assert.equal(instance.status, "provisioning");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://synthetic.example/v1/runner/start");
    assert.deepEqual(calls[0]!.body, { runnerId: instance.providerRunnerId, apiUrl: "https://product.example/api", runnerToken: "raw-token" });
  });

  it("provisionRunner() throws with a clear message on a non-OK response", async () => {
    const provider = createCloudflareContainerAsyncRunnerProvider({ workerBaseUrl: "https://x", controlToken: "t" }, fakeFetch(() => ({ status: 500, body: { ok: false, error: "boom" } })));
    await assert.rejects(() => provider.provisionRunner(baseRequest()), /Cloudflare Containers async start failed/);
  });

  it("terminateRunner() calls /v1/runner/terminate and never throws even on a non-OK response (Part 9 idempotency contract)", async () => {
    const provider = createCloudflareContainerAsyncRunnerProvider({ workerBaseUrl: "https://x", controlToken: "t" }, fakeFetch(() => ({ status: 404, body: { ok: false } })));
    await assert.doesNotReject(() => provider.terminateRunner("some-id"));
  });

  it("getRunnerStatus() never throws for an unknown id - honest, non-crashing fallback", async () => {
    const provider = createCloudflareContainerAsyncRunnerProvider({ workerBaseUrl: "https://x", controlToken: "t" }, fakeFetch(() => ({ status: 200, body: {} })));
    const result = await provider.getRunnerStatus("unknown-id");
    assert.ok(result.status);
  });
});

describe("Part 8: provision idempotency - retry does not create a second logical instance", () => {
  it("provisionRunner() called twice with the SAME runnerCredential.runnerId always computes the SAME providerRunnerId", async () => {
    const provider = createCloudflareContainerAsyncRunnerProvider({ workerBaseUrl: "https://x", controlToken: "t" }, fakeFetch(() => ({ status: 200, body: { ok: true } })));
    const request = baseRequest();
    const first = await provider.provisionRunner(request);
    const second = await provider.provisionRunner(request); // simulates a retry after network uncertainty
    assert.equal(first.providerRunnerId, second.providerRunnerId, "a retry must target the same underlying Cloudflare Sandbox Durable Object id, never spin up a second billable instance");
  });

  it("the providerRunnerId is DERIVED from the internal runnerId, not randomly generated per call - this is the actual idempotency mechanism", async () => {
    const provider = createCloudflareContainerAsyncRunnerProvider({ workerBaseUrl: "https://x", controlToken: "t" }, fakeFetch(() => ({ status: 200, body: { ok: true } })));
    const a = await provider.provisionRunner({ ...baseRequest(), runnerCredential: { ...baseRequest().runnerCredential!, runnerId: "runner-X" } });
    const b = await provider.provisionRunner({ ...baseRequest(), runnerCredential: { ...baseRequest().runnerCredential!, runnerId: "runner-Y" } });
    assert.notEqual(a.providerRunnerId, b.providerRunnerId, "different internal runners must still get different provider ids");
    assert.match(a.providerRunnerId, /runner-X/);
    assert.match(b.providerRunnerId, /runner-Y/);
  });
});

describe("Part 9: termination idempotency", () => {
  it("terminate then terminate again both succeed - success/no-op semantics, no throw on the second call", async () => {
    let callCount = 0;
    const provider = createCloudflareContainerAsyncRunnerProvider(
      { workerBaseUrl: "https://x", controlToken: "t" },
      fakeFetch(() => {
        callCount++;
        // First call: real container, terminates successfully. Second call: already gone (404) - still
        // must not throw, per the provider's own idempotent contract.
        return { status: callCount === 1 ? 200 : 404, body: { ok: callCount === 1 } };
      }),
    );
    await provider.terminateRunner("r1-runner-abc");
    await assert.doesNotReject(() => provider.terminateRunner("r1-runner-abc"));
    assert.equal(callCount, 2);
  });

  it("terminating a runner id that was never provisioned by this provider instance does not throw", async () => {
    const provider = createCloudflareContainerAsyncRunnerProvider({ workerBaseUrl: "https://x", controlToken: "t" }, fakeFetch(() => ({ status: 404, body: { ok: false } })));
    await assert.doesNotReject(() => provider.terminateRunner("never-existed"));
  });
});
