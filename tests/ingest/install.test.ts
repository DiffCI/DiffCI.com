/**
 * What a stranger is handed at the end of self-serve signup.
 *
 * The test that matters most is the last one: the workflow the product generates is written to disk
 * and run through DiffCI's own non-interference guard. If onboarding ever emits an installation that
 * `verify-workflow` rejects, the product would be telling people to do the thing it tells them not to.
 *
 * The rest are about the pin. DiffCI is proprietary and ships as an authenticated package, so the
 * generated workflow installs an exact version rather than referencing a public Action - and the
 * property that survived that change is that whatever executes in a customer's CI is fixed when they
 * install it.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import YAML from "yaml";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

import { buildInstallInstructions } from "../../src/ingest/install.js";
import { pinnedArtifact, TEST_INTEGRITY, TEST_PINNED_AGENT } from "../helpers/agent-artifact.js";
import { auditWorkflows, isNonInterfering } from "../../src/client/workflow-guard.js";

const repository = { ownerName: "acme/checkout", defaultBranch: "trunk" };

describe("self-serve install instructions", () => {
  it("installs the public observer without asking for a registry credential", () => {
    const install = buildInstallInstructions({ repository, agentArtifact: pinnedArtifact(`npm:@diffci.com/diffci@0.2.11#${TEST_INTEGRITY}`), apiOrigin: "https://app.diffci.test" });
    assert.equal(install.registrySecretName, undefined);
    assert.ok(!install.workflowYaml.includes("DIFFCI_REGISTRY_TOKEN"));
    assert.ok(!install.steps.join(" ").includes("registry credential"));
    const workflow = YAML.parse(install.workflowYaml);
    assert.equal(workflow.jobs.diffci["runs-on"], "ubuntu-24.04");
    assert.ok(workflow.jobs.diffci.steps.some((s: { uses?: string }) => s.uses === "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"));
    assert.equal(workflow.jobs.diffci.steps.find((s: { uses?: string }) => s.uses === "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020").with["node-version"], "22");
  });

  it("the emitted verifier accepts the pinned bytes and refuses a tampered tarball before installation", () => {
    const dir = mkdtempSync(join(tmpdir(), "diffci-install-integrity-"));
    try {
      const bytes = Buffer.from("package bytes");
      const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
      const install = buildInstallInstructions({ repository, agentArtifact: pinnedArtifact(`npm:@diffci.com/diffci@0.2.11#${integrity}`), apiOrigin: "https://app.diffci.test" });
      const workflow = YAML.parse(install.workflowYaml);
      const script: string = workflow.jobs.diffci.steps.find((s: { name?: string }) => s.name === "Install DiffCI").run;
      const verifier = script.match(/node -e '([^']+)'/)![1]!;
      const file = join(dir, "observer.tgz");
      writeFileSync(file, bytes);
      assert.equal(spawnSync(process.execPath, ["-e", verifier, file, integrity]).status, 0);
      writeFileSync(file, "tampered");
      assert.notEqual(spawnSync(process.execPath, ["-e", verifier, file, integrity]).status, 0);
      assert.ok(script.indexOf("node -e") < script.indexOf("npm install"));
      assert.match(script, /set -euo pipefail/);
      assert.match(script, /--ignore-scripts --no-audit/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("names both secrets, the file, and the endpoint reports go to", () => {
    const install = buildInstallInstructions({ repository, agentArtifact: TEST_PINNED_AGENT, apiOrigin: "https://app.diffci.test/" });

    assert.equal(install.secretName, "DIFFCI_TOKEN");
    assert.equal(install.registrySecretName, "DIFFCI_REGISTRY_TOKEN");
    assert.equal(install.workflowPath, ".github/workflows/diffci-observe.yml");
    assert.equal(install.ingestUrl, "https://app.diffci.test/v1/ingest/observations");
    assert.ok(install.steps.length >= 3);
    assert.ok(install.steps.some((step) => step.includes("DIFFCI_TOKEN")));
    assert.ok(install.steps.some((step) => step.includes("DIFFCI_REGISTRY_TOKEN")));
  });

  it("puts both credentials in secret references, never in the file that gets committed", () => {
    const install = buildInstallInstructions({ repository, agentArtifact: TEST_PINNED_AGENT, apiOrigin: "https://app.diffci.test" });
    assert.ok(install.workflowYaml.includes("${{ secrets.DIFFCI_TOKEN }}"));
    assert.ok(install.workflowYaml.includes("${{ secrets.DIFFCI_REGISTRY_TOKEN }}"));
    assert.equal(install.workflowYaml.includes("dci_"), false);
    // The integrity hash is a public fact about a published artifact, not a credential - but the
    // registry token that fetches it must never appear literally.
    assert.equal(install.workflowYaml.includes(TEST_INTEGRITY.slice(0, 20)) && install.workflowYaml.includes("npm_"), false);
  });

  it("observes the repository's own default branch, not an assumed one", () => {
    const install = buildInstallInstructions({ repository, agentArtifact: TEST_PINNED_AGENT, apiOrigin: "https://app.diffci.test" });
    assert.ok(install.workflowYaml.includes("branches: [trunk]"));
  });

  it("installs an exact version, and nothing that could resolve to something newer", () => {
    const install = buildInstallInstructions({ repository, agentArtifact: TEST_PINNED_AGENT, apiOrigin: "https://app.diffci.test" });
    assert.ok(install.workflowYaml.includes("@diffci/observer@1.4.2"), "the exact version must appear in the workflow");
    assert.equal(install.agent, "@diffci/observer@1.4.2");
    assert.equal(install.agentIntegrity, TEST_INTEGRITY);

    // No range operator, dist-tag, or wildcard may appear anywhere in a generated workflow.
    for (const mutable of ["@latest", "@next", "@beta", "^1.", "~1.", "1.x", "@*"]) {
      assert.equal(install.workflowYaml.includes(mutable), false, `a generated workflow must never contain "${mutable}"`);
    }
  });

  it("emits a container run addressed by digest when the artifact is an image", () => {
    const oci = pinnedArtifact(`oci:ghcr.io/diffci/observer@sha256:${"b".repeat(64)}`);
    const install = buildInstallInstructions({ repository, agentArtifact: oci, apiOrigin: "https://app.diffci.test" });
    assert.ok(install.workflowYaml.includes(`sha256:${"b".repeat(64)}`));
    assert.equal(install.workflowYaml.includes(":latest"), false);
  });

  it("generates valid YAML, and installs and runs outside the checkout", () => {
    // Both of these were real defects. An inline `run:` starting with a quote made the file
    // unparseable, which the guard could only report as "no DiffCI job here" - a silent pass. And an
    // install into the workspace would have created node_modules inside the repository being
    // observed, breaking the one promise the installation makes.
    const install = buildInstallInstructions({ repository, agentArtifact: TEST_PINNED_AGENT, apiOrigin: "https://app.diffci.test" });
    const parsed = YAML.parse(install.workflowYaml) as { jobs: Record<string, { steps: Array<Record<string, unknown>> }> };
    assert.ok(parsed.jobs.diffci, "the workflow must parse and contain the diffci job");

    const runSteps = parsed.jobs.diffci.steps.filter((step) => typeof step.run === "string").map((step) => step.run as string);
    assert.ok(runSteps.length >= 2);
    for (const run of runSteps) {
      assert.ok(run.includes("RUNNER_TEMP"), `every DiffCI shell step must work outside the checkout: ${run}`);
    }
    assert.equal(install.workflowYaml.includes("--no-save"), false, "installing into the workspace is what --no-save implies; it must not appear");
  });

  it("generates a workflow that passes DiffCI's own non-interference guard", () => {
    const install = buildInstallInstructions({ repository, agentArtifact: TEST_PINNED_AGENT, apiOrigin: "https://app.diffci.test" });
    const dir = mkdtempSync(join(tmpdir(), "diffci-install-"));
    try {
      mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
      writeFileSync(join(dir, install.workflowPath), install.workflowYaml);

      const audit = auditWorkflows(dir);
      assert.equal(audit.observerJobs.length, 1, "the generated job should be recognised as a DiffCI job");
      assert.deepEqual(audit.findings, [], "onboarding must not generate an installation its own checker rejects");
      assert.equal(isNonInterfering(audit), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
