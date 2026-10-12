import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { reportInstallationFailure } from "../../../src/product/cloudflare/conversion-telemetry.js";

const originalFetch = globalThis.fetch;
const originalWarn = console.warn;

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
});

describe("installation webhook telemetry", () => {
  it("keeps invalid signatures out of Sentry and emits only a sanitized sampled Worker log", async () => {
    let fetches = 0;
    const warnings: string[] = [];
    globalThis.fetch = async () => {
      fetches += 1;
      return new Response(null, { status: 200 });
    };
    console.warn = (message?: unknown) => { warnings.push(String(message)); };

    for (const [reason, source] of [["invalid-signature", "research"], ["bad_signature", "product"]] as const) {
      await reportInstallationFailure({ SENTRY_DSN: "https://public@example.invalid/1" }, reason, source);
      await reportInstallationFailure({ SENTRY_DSN: "https://public@example.invalid/1" }, reason, source);
    }

    assert.equal(fetches, 0, "unauthenticated rejections must not create Sentry events");
    assert.equal(warnings.length, 2, "one Worker-isolate sample is kept per source/reason time window");
    assert.deepEqual(warnings.map((warning) => JSON.parse(warning)), [
      {
        event: "github_installation_webhook.unauthenticated_rejection_sampled",
        source: "research",
        reason: "invalid-signature",
        sample_interval_ms: 300000,
      },
      {
        event: "github_installation_webhook.unauthenticated_rejection_sampled",
        source: "product",
        reason: "bad_signature",
        sample_interval_ms: 300000,
      },
    ]);
  });

  it("continues to report authenticated/operational failures to Sentry", async () => {
    let body = "";
    globalThis.fetch = async (_input, init) => {
      body = String(init?.body);
      return new Response(null, { status: 200 });
    };

    await reportInstallationFailure({ SENTRY_DSN: "https://public@example.invalid/1" }, "erasure_unavailable", "product");

    assert.match(body, /github_installation_webhook_failed:erasure_unavailable/);
    assert.match(body, /\"level\":\"error\"/);
  });
});
