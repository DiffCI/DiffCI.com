import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BillingConfigError, parseLemonSqueezyConfig, tryLoadLemonSqueezyConfig } from "../../src/billing/config.js";

describe("parseLemonSqueezyConfig - Part 5 validation", () => {
  it("parses a complete, valid config", () => {
    const cfg = parseLemonSqueezyConfig({
      LEMONSQUEEZY_API_KEY: "key",
      LEMONSQUEEZY_WEBHOOK_SECRET: "secret",
      LEMONSQUEEZY_STORE_ID: "store1",
      LEMONSQUEEZY_VARIANT_IDS: JSON.stringify({ developer: "v1", team: "v2" }),
    });
    assert.equal(cfg.storeId, "store1");
    assert.deepEqual(cfg.variantIdsByPlan, { developer: "v1", team: "v2" });
  });

  it("throws BillingConfigError listing every missing required field", () => {
    assert.throws(() => parseLemonSqueezyConfig({}), (err: unknown) => {
      assert.ok(err instanceof BillingConfigError);
      assert.match(err.message, /LEMONSQUEEZY_API_KEY/);
      assert.match(err.message, /LEMONSQUEEZY_WEBHOOK_SECRET/);
      assert.match(err.message, /LEMONSQUEEZY_STORE_ID/);
      return true;
    });
  });

  it("throws on malformed JSON in LEMONSQUEEZY_VARIANT_IDS", () => {
    assert.throws(
      () => parseLemonSqueezyConfig({ LEMONSQUEEZY_API_KEY: "k", LEMONSQUEEZY_WEBHOOK_SECRET: "s", LEMONSQUEEZY_STORE_ID: "id", LEMONSQUEEZY_VARIANT_IDS: "{not json" }),
      BillingConfigError,
    );
  });

  it("throws on a non-string variant id value", () => {
    assert.throws(
      () =>
        parseLemonSqueezyConfig({
          LEMONSQUEEZY_API_KEY: "k",
          LEMONSQUEEZY_WEBHOOK_SECRET: "s",
          LEMONSQUEEZY_STORE_ID: "id",
          LEMONSQUEEZY_VARIANT_IDS: JSON.stringify({ developer: 123 }),
        }),
      BillingConfigError,
    );
  });

  it("works with no variant ids configured at all (nothing purchasable yet, still valid)", () => {
    const cfg = parseLemonSqueezyConfig({ LEMONSQUEEZY_API_KEY: "k", LEMONSQUEEZY_WEBHOOK_SECRET: "s", LEMONSQUEEZY_STORE_ID: "id" });
    assert.deepEqual(cfg.variantIdsByPlan, {});
  });
});

describe("tryLoadLemonSqueezyConfig - Part 5 dev/test without production credentials", () => {
  it("returns undefined when nothing at all is configured", () => {
    assert.equal(tryLoadLemonSqueezyConfig({}), undefined);
  });

  it("throws (does not silently return undefined) when PARTIALLY configured", () => {
    assert.throws(() => tryLoadLemonSqueezyConfig({ LEMONSQUEEZY_API_KEY: "k" }), BillingConfigError);
  });

  it("returns a config when fully configured", () => {
    const cfg = tryLoadLemonSqueezyConfig({ LEMONSQUEEZY_API_KEY: "k", LEMONSQUEEZY_WEBHOOK_SECRET: "s", LEMONSQUEEZY_STORE_ID: "id" });
    assert.ok(cfg);
  });
});
