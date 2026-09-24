import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("public read-only GitHub App consolidation", () => {
  it("uses one unified manifest for discovery and shadow events with read-only permissions", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "ops/github-app/diffci-product-app-manifest.json"), "utf8")) as {
      name: string;
      default_permissions: Record<string, string>;
      default_events: string[];
      hook_attributes: { url: string };
    };
    assert.equal(manifest.name, "DiffCI");
    assert.deepEqual(manifest.default_permissions, { metadata: "read", contents: "read", actions: "read", checks: "read" });
    assert.deepEqual(new Set(manifest.default_events), new Set(["installation", "installation_repositories", "push", "workflow_run"]));
    assert.equal(manifest.hook_attributes.url, "https://app.diffci.com/v1/webhooks/github");
    assert.equal(Object.values(manifest.default_permissions).includes("write"), false);
  });

  it("marks the former Shadow manifest as legacy rather than presenting it as another App", () => {
    const legacy = JSON.parse(readFileSync(join(ROOT, "ops/github-app/diffci-shadow-app-manifest.json"), "utf8")) as { name: string; description: string };
    assert.match(legacy.name, /legacy/i);
    assert.match(legacy.description, /Do not register new installations/i);
  });
});
