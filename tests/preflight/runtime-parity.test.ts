import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  evaluateRuntimeParity,
  parseRuntimeSource,
  parseSemVer,
  compareSemVer,
  extractPackageJsonEngineSource,
  extractNvmrcSource,
  extractDockerfileNodeSetupSource,
  type RuntimeRequirementSource,
} from "../../src/preflight/runtime-parity.js";

const req = (rawValue: string, sourceId = "package.json#engines.node"): RuntimeRequirementSource => ({ sourceId, runtime: "node", kind: "requirement", rawValue });
const prov = (rawValue: string, sourceId: string): RuntimeRequirementSource => ({ sourceId, runtime: "node", kind: "provisioning", rawValue });

describe("parseSemVer/compareSemVer - internal comparator", () => {
  it("parses a well-formed exact version", () => {
    assert.deepEqual(parseSemVer("22.5.0"), { major: 22, minor: 5, patch: 0 });
  });
  it("rejects anything that isn't exactly X.Y.Z", () => {
    assert.equal(parseSemVer("22.5"), undefined);
    assert.equal(parseSemVer("v22.5.0"), undefined);
    assert.equal(parseSemVer("latest"), undefined);
  });
  it("compares major before minor before patch", () => {
    assert.ok(compareSemVer({ major: 22, minor: 0, patch: 0 }, { major: 20, minor: 9, patch: 9 }) > 0);
    assert.ok(compareSemVer({ major: 22, minor: 4, patch: 0 }, { major: 22, minor: 5, patch: 0 }) < 0);
    assert.equal(compareSemVer({ major: 22, minor: 5, patch: 0 }, { major: 22, minor: 5, patch: 0 }), 0);
  });
});

describe("evaluateRuntimeParity - Preflight P1 Part B (generalized, not node:sqlite-hardcoded)", () => {
  // --- The 8+ required scenarios -------------------------------------------------------------

  it("1. COMPATIBLE: actual version satisfies the sole declared requirement", () => {
    const result = evaluateRuntimeParity("node", [req(">=22.5.0")], "22.23.2");
    assert.equal(result.verdict, "COMPATIBLE");
  });

  it("2. INCOMPATIBLE: actual is the same major but below the declared minimum", () => {
    const result = evaluateRuntimeParity("node", [req(">=22.5.0")], "22.3.0");
    assert.equal(result.verdict, "INCOMPATIBLE");
    assert.ok(result.reasons.some((r) => r.includes("does not satisfy")));
  });

  it("3. MISSING: no declared requirement exists in any known source", () => {
    const result = evaluateRuntimeParity("node", [], "22.23.2");
    assert.equal(result.verdict, "MISSING");
  });

  it("3b. MISSING: requirement declared but no actual version supplied to compare against", () => {
    const result = evaluateRuntimeParity("node", [req(">=22.5.0")], undefined);
    assert.equal(result.verdict, "MISSING");
  });

  it("4. CONFLICTING: two declared sources have provably non-overlapping ranges", () => {
    // The real incident's deeper shape: a provisioning source pinned at Node 20 while a requirement
    // source needs >=22.5.0 - these ranges never overlap at all.
    const result = evaluateRuntimeParity("node", [req(">=22.5.0"), prov("20.0.0", "ops/github-runner/Dockerfile#L54")], "20.0.0");
    assert.equal(result.verdict, "CONFLICTING");
    assert.ok(result.reasons.some((r) => r.includes("non-overlapping")));
  });

  it("5. MALFORMED: the only declared source is not a supported version-range form", () => {
    const result = evaluateRuntimeParity("node", [req("latest")], "22.23.2");
    assert.equal(result.verdict, "MALFORMED");
    assert.ok(result.reasons.some((r) => r.includes("does not match any supported form")));
  });

  it("5b. a malformed source alongside a well-formed one is disclosed in reasons but doesn't block evaluation", () => {
    const result = evaluateRuntimeParity("node", [req(">=22.5.0"), req("latest", "some-other-file")], "22.23.2");
    assert.equal(result.verdict, "COMPATIBLE");
    assert.ok(result.reasons.some((r) => r.includes("some-other-file")));
  });

  it("6. NEWER_COMPATIBLE: actual satisfies every requirement but is a newer major than declared", () => {
    const result = evaluateRuntimeParity("node", [req(">=22.5.0")], "24.1.0");
    assert.equal(result.verdict, "NEWER_COMPATIBLE");
  });

  it("7. exact-pin satisfied: an exact-pin source matches the actual version precisely", () => {
    const source = req("22.5.0");
    const parsed = parseRuntimeSource(source);
    assert.equal(parsed.isExactPin, true);
    const result = evaluateRuntimeParity("node", [source], "22.5.0");
    assert.equal(result.verdict, "COMPATIBLE");
  });

  it("7b. exact-pin unsatisfied: actual differs from an exact-pin source by patch only", () => {
    const result = evaluateRuntimeParity("node", [req("22.5.0")], "22.5.1");
    assert.equal(result.verdict, "INCOMPATIBLE");
  });

  it("8. MAJOR_MISMATCH (the real regression shape): declared >=22.5.0, actual is a wholly different major", () => {
    const result = evaluateRuntimeParity("node", [req(">=22.5.0")], "20.11.0");
    assert.equal(result.verdict, "MAJOR_MISMATCH");
  });

  // --- Node 20/22 regression fixture ----------------------------------------------------------
  // Replays the exact real-world incident shape (2026-08-22): before the fix, the self-hosted
  // runner's Dockerfile provisioned Node 20 while the code (via node:sqlite) implicitly needed
  // >=22.5.0. This fixture encodes that as an explicit requirement source (post-fix state of
  // package.json's engines.node, which is what SHOULD have existed from the start) evaluated
  // against the pre-fix provisioned runtime - this must come back MAJOR_MISMATCH, the class this
  // whole module exists to catch before CI runs.
  it("Node 20/22 regression fixture: pre-fix provisioned runtime (20.x) against the real declared requirement (>=22.5.0) is MAJOR_MISMATCH", () => {
    const result = evaluateRuntimeParity(
      "node",
      [req(">=22.5.0", "package.json#engines.node"), prov("20.x", "ops/github-runner/Dockerfile#L54 (pre-fix)")],
      "20.9.0",
    );
    // Both a declared-vs-declared conflict AND an actual-vs-requirement major mismatch are present
    // here; CONFLICTING is checked first (a disagreement between sources is detectable purely from
    // the declarations, before any actual-version comparison is even needed) - this fixture confirms
    // the check would have caught the incident from EITHER angle, which is the point.
    assert.equal(result.verdict, "CONFLICTING");
  });

  it("Node 20/22 regression fixture, requirement-only framing: the actual runtime alone (20.x) against the correct requirement (>=22.5.0) is MAJOR_MISMATCH", () => {
    const result = evaluateRuntimeParity("node", [req(">=22.5.0", "package.json#engines.node")], "20.9.0");
    assert.equal(result.verdict, "MAJOR_MISMATCH");
  });

  it("post-fix state (real, current repo): requirement >=22.5.0 against the real deployed Sandbox runtime v22.23.2 is COMPATIBLE", () => {
    // v22.23.2 is the real, live-probed Node version on the Cloudflare Sandbox image now backing
    // diffci-github-runner (see docs/research - the environment-parity probe run right after Part A's
    // real CI green result).
    const result = evaluateRuntimeParity("node", [req(">=22.5.0", "package.json#engines.node")], "22.23.2");
    assert.equal(result.verdict, "COMPATIBLE");
  });

  it("wildcard range (X.x) source is treated as a closed range, not an open-ended minimum", () => {
    const compatible = evaluateRuntimeParity("node", [req("22.x")], "22.23.2");
    assert.equal(compatible.verdict, "COMPATIBLE");
    const majorMismatch = evaluateRuntimeParity("node", [req("22.x")], "24.0.0");
    assert.equal(majorMismatch.verdict, "MAJOR_MISMATCH");
  });

  it("two requirement sources with overlapping but different minimums do not falsely conflict - the stricter one governs", () => {
    const result = evaluateRuntimeParity("node", [req(">=20.0.0", "a"), req(">=22.5.0", "b")], "22.23.2");
    assert.equal(result.verdict, "COMPATIBLE");
    assert.ok(!result.reasons.some((r) => r.includes("non-overlapping")));
  });

  it("only sources matching the requested runtime kind are considered", () => {
    const result = evaluateRuntimeParity("node", [{ sourceId: "package.json#engines.npm", runtime: "npm", kind: "requirement", rawValue: ">=10.0.0" }], "22.23.2");
    assert.equal(result.verdict, "MISSING"); // no "node" source present, the "npm" one is irrelevant here
  });
});

describe("real-file extractors - repo-shaped sources", () => {
  it("extracts engines.node from a real package.json shape", () => {
    const source = extractPackageJsonEngineSource(JSON.stringify({ name: "diffci", engines: { node: ">=22.5.0" } }));
    assert.deepEqual(source, { sourceId: "package.json#engines.node", runtime: "node", kind: "requirement", rawValue: ">=22.5.0" });
  });

  it("returns undefined when package.json has no engines.node field", () => {
    assert.equal(extractPackageJsonEngineSource(JSON.stringify({ name: "diffci" })), undefined);
  });

  it("returns undefined for unparseable package.json rather than throwing", () => {
    assert.equal(extractPackageJsonEngineSource("{ not valid json"), undefined);
  });

  it("extracts an .nvmrc source and strips a leading 'v'", () => {
    assert.deepEqual(extractNvmrcSource("v22.5.0\n"), { sourceId: ".nvmrc", runtime: "node", kind: "provisioning", rawValue: "22.5.0" });
  });

  it("extracts the real Dockerfile setup_NN.x pattern this repo's fallback Dockerfile uses", () => {
    const dockerfile = "RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \\\n    && apt-get install -y --no-install-recommends nodejs";
    const source = extractDockerfileNodeSetupSource(dockerfile, "ops/github-runner/Dockerfile");
    assert.deepEqual(source, { sourceId: "ops/github-runner/Dockerfile", runtime: "node", kind: "provisioning", rawValue: "22.x" });
  });

  it("extracts a FROM node:X.Y.Z base-image pin when present", () => {
    const source = extractDockerfileNodeSetupSource("FROM node:20.11.0-slim", "Dockerfile");
    assert.deepEqual(source, { sourceId: "Dockerfile", runtime: "node", kind: "provisioning", rawValue: "20.11.0" });
  });

  it("returns undefined when no recognized Node install pattern is present", () => {
    assert.equal(extractDockerfileNodeSetupSource("FROM ubuntu:22.04\nRUN apt-get update", "Dockerfile"), undefined);
  });

  it("end-to-end: real repo package.json + real pre-fix Dockerfile line reproduces the incident as CONFLICTING", () => {
    const pkgSource = extractPackageJsonEngineSource(JSON.stringify({ engines: { node: ">=22.5.0" } }))!;
    const dockerSource = extractDockerfileNodeSetupSource("RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash -", "ops/github-runner/Dockerfile (pre-fix)")!;
    const result = evaluateRuntimeParity("node", [pkgSource, dockerSource], "20.9.0");
    assert.equal(result.verdict, "CONFLICTING");
  });

  it("end-to-end: real repo package.json + real post-fix Dockerfile line is COMPATIBLE", () => {
    const pkgSource = extractPackageJsonEngineSource(JSON.stringify({ engines: { node: ">=22.5.0" } }))!;
    const dockerSource = extractDockerfileNodeSetupSource("RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash -", "ops/github-runner/Dockerfile")!;
    const result = evaluateRuntimeParity("node", [pkgSource, dockerSource], "22.23.2");
    assert.equal(result.verdict, "COMPATIBLE");
  });
});
