import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import productWorker from "../../../src/product/cloudflare/product-worker.js";
import { reportOptInCliUsage } from "../../../src/product/cloudflare/conversion-telemetry.js";
import { freshProductDb, makeD1 } from "../../helpers/product-db.js";

const ORIGIN = "https://product.example";
const originalFetch = globalThis.fetch;

function env(posthogKey?: string): Record<string, unknown> {
  const d1 = makeD1(freshProductDb(["ingest", "usage", "auth"]));
  return {
    PRODUCT_DB: d1,
    RESEARCH_DB: d1,
    DIFFCI_PRODUCT_ENABLED: "true",
    DIFFCI_ENVIRONMENT: "development",
    DIFFCI_ALLOW_DEV_HEADER_AUTH: "true",
    DIFFCI_API_ORIGIN: ORIGIN,
    ...(posthogKey ? { POSTHOG_API_KEY: posthogKey } : {}),
  };
}

async function post(body: unknown, workerEnv: Record<string, unknown>, waits: Promise<unknown>[] = []) {
  const response = await productWorker.fetch(
    new Request(`${ORIGIN}/v1/usage-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    workerEnv as never,
    { waitUntil(promise: Promise<unknown>) { waits.push(promise); } } as never,
  );
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

afterEach(() => { globalThis.fetch = originalFetch; });

describe("product Worker opt-in CLI telemetry", () => {
  it("reports unavailable collection when PostHog is not configured", async () => {
    const response = await post({}, env());
    assert.equal(response.status, 503);
    assert.equal(response.body.error, "usage_collection_unavailable");
  });

  it("validates the privacy-minimised payload before accepting it", async () => {
    const response = await post({ schema: "wrong", command: "check", outcome: "observed", version: "0.2.7" }, env("phc_test"));
    assert.equal(response.status, 400);
  });

  it("accepts a valid event and sends the expected PostHog capture", async () => {
    let capture: Record<string, unknown> | undefined;
    globalThis.fetch = async (_input, init) => {
      capture = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(null, { status: 200 });
    };
    const waits: Promise<unknown>[] = [];
    const response = await post(
      { schema: "diffci.usage.v1", command: "check", outcome: "observed", version: "0.2.7" },
      env("phc_test"),
      waits,
    );
    assert.equal(response.status, 202);
    await Promise.all(waits);
    assert.equal(capture?.event, "cli_usage_opt_in");
    assert.equal(capture?.api_key, "phc_test");
    assert.deepEqual(capture?.properties, {
      distinct_id: "diffci-cli-opt-in",
      command: "check",
      outcome: "observed",
      version: "0.2.7",
      $process_person_profile: false,
      $geoip_disable: true,
    });
  });

  it("surfaces a rejected PostHog capture to the Worker's background task", async () => {
    globalThis.fetch = async () => new Response(null, { status: 401 });
    await assert.rejects(
      reportOptInCliUsage({ POSTHOG_API_KEY: "wrong" }, "observe", "error", "0.2.7"),
      /PostHog capture failed with HTTP 401/,
    );
  });
});
