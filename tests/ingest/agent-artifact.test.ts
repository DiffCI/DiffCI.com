/**
 * The pinned-agent-artifact invariant (2026-08-27).
 *
 * This replaces the pinned-action-ref tests. The distribution architecture changed - DiffCI is
 * proprietary and ships as an authenticated package rather than a public GitHub Action - but the
 * security property did not, and restating it was the point of the change:
 *
 *     No customer credential or installation instruction may be generated unless it identifies an
 *     immutable, integrity-verifiable DiffCI agent artifact.
 *
 * The thing being defended is the same one the old Action-SHA rule defended: whatever executes inside
 * a customer's CI must be fixed at the moment they install it, and must not be able to change
 * afterwards without their repository changing. A semver range is the new `@main`.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { parseAgentArtifact, isPinnedAgentArtifact } from "../../src/ingest/agent-artifact.js";
import { TEST_INTEGRITY } from "../helpers/agent-artifact.js";

const DIGEST = "a".repeat(64);

describe("parseAgentArtifact - npm", () => {
  it("accepts an exact version with an integrity hash, and exposes its parts", () => {
    const parsed = parseAgentArtifact(`npm:@diffci/observer@1.4.2#${TEST_INTEGRITY}`);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.artifact.kind, "npm");
    if (parsed.artifact.kind !== "npm") return;
    assert.equal(parsed.artifact.name, "@diffci/observer");
    assert.equal(parsed.artifact.version, "1.4.2");
    assert.equal(parsed.artifact.integrity, TEST_INTEGRITY);
    assert.equal(parsed.artifact.display, "@diffci/observer@1.4.2");
  });

  it("accepts prerelease and build metadata, which are still exact versions", () => {
    for (const version of ["1.4.2-rc.1", "1.4.2+build.7", "1.4.2-rc.1+build.7"]) {
      const parsed = parseAgentArtifact(`npm:@diffci/observer@${version}#${TEST_INTEGRITY}`);
      assert.equal(parsed.ok, true, `${version} is exact and should parse`);
    }
  });

  it("refuses every version form that resolves to whatever is newest", () => {
    // Each of these is the same hole `@main` was: the bytes executing in a customer's CI can change
    // without their repository changing, and neither they nor DiffCI would see a diff.
    for (const range of ["latest", "next", "beta", "canary", "^1.4.2", "~1.4.2", "1.x", "1.4.x", ">=1.4.2", "1.4.2 || 1.5.0", "*", "x"]) {
      const parsed = parseAgentArtifact(`npm:@diffci/observer@${range}#${TEST_INTEGRITY}`);
      assert.equal(parsed.ok, false, `"${range}" must not parse as pinned`);
      if (parsed.ok) return;
      assert.equal(parsed.rejection, "not_immutable", `"${range}" is mutable, not malformed`);
    }
  });

  it("refuses an exact version with no integrity hash", () => {
    // An exact version alone is weaker than it looks: it names which artifact we meant, but gives the
    // customer's package manager nothing to check the received bytes against.
    const parsed = parseAgentArtifact("npm:@diffci/observer@1.4.2");
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    assert.equal(parsed.rejection, "not_verifiable");
  });

  it("refuses an integrity value that is not a real subresource-integrity hash", () => {
    for (const bad of ["not-a-hash", "sha512-", "md5-abcdef", "sha512 abc", TEST_INTEGRITY.replace("sha512-", "")]) {
      const parsed = parseAgentArtifact(`npm:@diffci/observer@1.4.2#${bad}`);
      assert.equal(parsed.ok, false, `"${bad}" must not be accepted as integrity`);
      if (parsed.ok) return;
      assert.equal(parsed.rejection, "not_verifiable");
    }
  });

  it("refuses malformed specifiers without calling them merely unpinned", () => {
    for (const malformed of [`npm:@diffci/observer#${TEST_INTEGRITY}`, `npm:@1.4.2#${TEST_INTEGRITY}`, `npm:UPPERCASE@1.4.2#${TEST_INTEGRITY}`, `npm:has space@1.4.2#${TEST_INTEGRITY}`]) {
      const parsed = parseAgentArtifact(malformed);
      assert.equal(parsed.ok, false, `"${malformed}" must not parse`);
      if (parsed.ok) return;
      assert.equal(parsed.rejection, "malformed");
    }
  });
});

describe("parseAgentArtifact - container images", () => {
  // Not issued yet. The shape is fixed now so that moving to an authenticated short-lived download, or
  // to a container, does not require rewriting every call site and re-litigating the invariant.
  it("accepts an image addressed by digest", () => {
    const parsed = parseAgentArtifact(`oci:ghcr.io/diffci/observer@sha256:${DIGEST}`);
    assert.equal(parsed.ok, true);
    if (!parsed.ok || parsed.artifact.kind !== "oci") return assert.fail("expected an oci artifact");
    assert.equal(parsed.artifact.image, "ghcr.io/diffci/observer");
    assert.equal(parsed.artifact.digest, `sha256:${DIGEST}`);
  });

  it("refuses an image addressed by tag, because a tag can be repointed", () => {
    const parsed = parseAgentArtifact("oci:ghcr.io/diffci/observer:v1");
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    assert.equal(parsed.rejection, "not_immutable");
  });
});

describe("parseAgentArtifact - configuration", () => {
  it("treats missing configuration as missing, not as malformed", () => {
    for (const empty of [undefined, null, "", "   "]) {
      const parsed = parseAgentArtifact(empty);
      assert.equal(parsed.ok, false);
      if (parsed.ok) return;
      assert.equal(parsed.rejection, "missing");
    }
  });

  it("refuses an unknown artifact kind rather than guessing one", () => {
    const parsed = parseAgentArtifact(`pypi:diffci-observer@1.4.2#${TEST_INTEGRITY}`);
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    assert.equal(parsed.rejection, "malformed");
  });

  it("does not resolve, expand, or repair anything", () => {
    // Resolving `latest` to the version it currently points at would mean asking the registry what it
    // thinks right now and enshrining an answer that can differ from the one the customer's runner
    // gets later - the same mutability problem in different clothes.
    assert.equal(parseAgentArtifact(`npm:@diffci/observer@latest#${TEST_INTEGRITY}`).ok, false);
  });

  it("isPinnedAgentArtifact agrees with parseAgentArtifact, so /health cannot drift from behaviour", () => {
    assert.equal(isPinnedAgentArtifact(`npm:@diffci/observer@1.4.2#${TEST_INTEGRITY}`), true);
    assert.equal(isPinnedAgentArtifact("npm:@diffci/observer@latest#" + TEST_INTEGRITY), false);
    assert.equal(isPinnedAgentArtifact(undefined), false);
  });
});
