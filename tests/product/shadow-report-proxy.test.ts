import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { proxyShadowReport } from "../../src/product/cloudflare/product-worker.js";

describe("proxyShadowReport", () => {
  it("forwards the report query through the Service Binding without exposing the workers.dev hostname", async () => {
    let upstream: Request | undefined;
    const response = await proxyShadowReport(
      new Request("https://app.diffci.com/report?repository=acme%2Fprivate&days=7&token=private-token"),
      { async fetch(request) { upstream = request; return new Response("report", { status: 200 }); } },
    );

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "report");
    assert.equal(upstream?.url, "https://diffci-research-sandbox.internal/v1/shadow/report?repository=acme%2Fprivate&days=7&token=private-token");
  });

  it("returns an honest service-unavailable response when the binding is absent", async () => {
    const response = await proxyShadowReport(new Request("https://app.diffci.com/report?repository=acme%2Fprivate"));
    assert.equal(response.status, 503);
    assert.match(await response.text(), /report service is not connected/);
  });
});
