import assert from "node:assert/strict";
import test from "node:test";
import worker, { type SiteEnv } from "../../src/site/site-worker.js";

function env(): SiteEnv {
  return {
    ASSETS: {
      async fetch(request: Request) {
        return new Response(new URL(request.url).pathname, { status: 200 });
      },
    },
  };
}

test("normalizes scheme and www host permanently", async () => {
  const www = await worker.fetch(new Request("https://www.diffci.com/docs/codex?ref=x"), env());
  assert.equal(www.status, 301);
  assert.equal(www.headers.get("location"), "https://diffci.com/docs/codex?ref=x");

  const forwardedHttp = await worker.fetch(
    new Request("https://diffci.com/", { headers: { "cf-visitor": JSON.stringify({ scheme: "http" }) } }),
    env(),
  );
  assert.equal(forwardedHttp.status, 301);
  assert.equal(forwardedHttp.headers.get("location"), "https://diffci.com/");
});

test("redirects legacy document variants to one clean URL", async () => {
  const html = await worker.fetch(new Request("https://diffci.com/docs/codex.html?source=old"), env());
  assert.equal(html.status, 308);
  assert.equal(html.headers.get("location"), "https://diffci.com/docs/codex?source=old");

  const rootIndex = await worker.fetch(new Request("https://diffci.com/index.html"), env());
  assert.equal(rootIndex.status, 308);
  assert.equal(rootIndex.headers.get("location"), "https://diffci.com/");

  const slash = await worker.fetch(new Request("https://diffci.com/docs/codex/"), env());
  assert.equal(slash.status, 308);
  assert.equal(slash.headers.get("location"), "https://diffci.com/docs/codex");

  const combined = await worker.fetch(new Request("https://www.diffci.com/docs/codex.html"), env());
  assert.equal(combined.status, 301);
  assert.equal(combined.headers.get("location"), "https://diffci.com/docs/codex");
});

test("passes canonical documents and assets through unchanged", async () => {
  const document = await worker.fetch(new Request("https://diffci.com/docs/codex"), env());
  assert.equal(document.status, 200);
  assert.equal(await document.text(), "/docs/codex");

  const asset = await worker.fetch(new Request("https://diffci.com/assets/diffci-mark.svg"), env());
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), "/assets/diffci-mark.svg");

});
