/**
 * ENGINE_COVERAGE_01 item 1, negative case 3
 * (docs/engine-coverage-01-item-1-implementation-plan.md §6): passing `--before=<cutoff>` to npm is not
 * itself trusted as proof the cutoff held for every dependency — `verifyTimeBoxedCutoff` independently
 * re-fetches each direct dependency's registry packument and re-checks its resolved version's own
 * publish time against the cutoff. These tests exercise that function directly, against a mocked
 * registry, so the four cases it must distinguish (confirmed, violated, unconfirmable, unreachable) are
 * each asserted on their own, not only inferred from an end-to-end run.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { verifyTimeBoxedCutoff } from "../../scripts/ci-reproduction.js";

const CUTOFF = "2026-09-01T08:25:03Z";

type Packument = { time?: Record<string, string> };

let originalFetch: typeof globalThis.fetch;
let registry: Record<string, Packument | "unreachable">;

before(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const name = decodeURIComponent(url.replace("https://registry.npmjs.org/", ""));
    const entry = registry[name];
    if (entry === undefined) return new Response("not found", { status: 404 });
    if (entry === "unreachable") throw new Error("simulated network failure");
    return new Response(JSON.stringify(entry), { status: 200 });
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = originalFetch;
});

test("confirmed: every direct dependency's resolved version was published on or before the cutoff", async () => {
  registry = { webpack: { time: { "5.109.2": "2026-08-15T00:00:00Z" } } };
  const result = await verifyTimeBoxedCutoff(["webpack"], { dependencies: { webpack: { version: "5.109.2" } } }, CUTOFF);
  assert.equal(result.verified, true);
  assert.match(result.detail, /1 direct dependency independently confirmed/);
});

test("violated: a resolved version published AFTER the cutoff fails verification, not silently accepted", async () => {
  // Exactly the babel-loader/member-5 scenario the investigation grounded this whole item in.
  registry = { webpack: { time: { "5.110.3": "2026-09-02T00:00:00Z" } } };
  const result = await verifyTimeBoxedCutoff(["webpack"], { dependencies: { webpack: { version: "5.110.3" } } }, CUTOFF);
  assert.equal(result.verified, false);
  assert.match(result.detail, /AFTER the cutoff/);
});

test("unconfirmable: a resolved version with no publish-time metadata refuses rather than assumes benign", async () => {
  registry = { "some-scoped-pkg": { time: {} } };
  const result = await verifyTimeBoxedCutoff(["some-scoped-pkg"], { dependencies: { "some-scoped-pkg": { version: "1.0.0" } } }, CUTOFF);
  assert.equal(result.verified, false);
  assert.match(result.detail, /no publish-time metadata/);
});

test("unreachable: a failed registry lookup refuses rather than trusting the install alone", async () => {
  registry = { webpack: "unreachable" };
  const result = await verifyTimeBoxedCutoff(["webpack"], { dependencies: { webpack: { version: "5.109.2" } } }, CUTOFF);
  assert.equal(result.verified, false);
  assert.match(result.detail, /registry lookup for "webpack" failed/);
});

test("a direct dependency absent from the resolved tree (e.g. optional/platform-specific) is skipped, not treated as a violation", async () => {
  registry = {};
  const result = await verifyTimeBoxedCutoff(["fsevents"], { dependencies: {} }, CUTOFF);
  assert.equal(result.verified, true);
  assert.match(result.detail, /0 direct dependenc/);
});
