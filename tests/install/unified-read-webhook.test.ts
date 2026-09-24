import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { forwardReadOnlyWebhook } from "../../src/install/unified-read-webhook.js";

describe("unified read-only GitHub App webhook routing", () => {
  for (const event of ["push", "workflow_run"]) {
    it(`forwards ${event} byte-for-byte to the shadow analyzer`, async () => {
      let forwarded: Request | undefined;
      const binding = { fetch: async (request: Request) => { forwarded = request; return Response.json({ ok: true, event }); } };
      const body = JSON.stringify({ repository: { full_name: "acme/app" }, event });
      const response = await forwardReadOnlyWebhook(new Request("https://app.diffci.com/v1/webhooks/github", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": event,
          "X-GitHub-Delivery": "delivery-1",
          "X-Hub-Signature-256": "sha256=abc",
          "Authorization": "must-not-forward",
        },
        body,
      }), binding);
      assert.equal(response?.status, 200);
      assert.equal(forwarded?.url, "https://research.internal/v1/shadow/webhook");
      assert.equal(await forwarded?.text(), body);
      assert.equal(forwarded?.headers.get("X-Hub-Signature-256"), "sha256=abc");
      assert.equal(forwarded?.headers.get("Authorization"), null);
    });
  }

  it("leaves installation events for the product installation handler", async () => {
    const response = await forwardReadOnlyWebhook(new Request("https://app.diffci.com/v1/webhooks/github", {
      method: "POST", headers: { "X-GitHub-Event": "installation" }, body: "{}",
    }), { fetch: async () => { throw new Error("must not forward"); } });
    assert.equal(response, undefined);
  });

  it("fails visibly when analysis routing is not configured", async () => {
    const response = await forwardReadOnlyWebhook(new Request("https://app.diffci.com/v1/webhooks/github", {
      method: "POST", headers: { "X-GitHub-Event": "push" }, body: "{}",
    }), undefined);
    assert.equal(response?.status, 503);
  });
});
