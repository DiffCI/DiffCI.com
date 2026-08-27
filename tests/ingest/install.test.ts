/**
 * Phase 03 (2026-08-26): what a stranger is handed at the end of self-serve signup.
 *
 * The test that matters here is the last one: the workflow the product generates is written to disk and
 * run through DiffCI's own non-interference guard. If onboarding ever emits an installation that
 * verify-workflow rejects, the product would be telling people to do the thing it tells them not to.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { buildInstallInstructions } from "../../src/ingest/install.js";
import { auditWorkflows, isNonInterfering } from "../../src/client/workflow-guard.js";

const PINNED = `adityankale190895/DiffCI.com@${"a".repeat(40)}`;
const repository = { ownerName: "acme/checkout", defaultBranch: "trunk" };

describe("self-serve install instructions", () => {
  it("names the secret, the file, and the endpoint reports go to", () => {
    const install = buildInstallInstructions({ repository, actionRef: PINNED, apiOrigin: "https://api.diffci.test/" });

    assert.equal(install.secretName, "DIFFCI_TOKEN");
    assert.equal(install.workflowPath, ".github/workflows/diffci-observe.yml");
    assert.equal(install.ingestUrl, "https://api.diffci.test/v1/ingest/observations");
    assert.ok(install.steps.length >= 3);
    assert.ok(install.steps.some((step) => step.includes("DIFFCI_TOKEN")));
  });

  it("puts the token in a secret reference, never in the file that gets committed", () => {
    const install = buildInstallInstructions({ repository, actionRef: PINNED, apiOrigin: "https://api.diffci.test" });
    assert.ok(install.workflowYaml.includes("${{ secrets.DIFFCI_TOKEN }}"));
    assert.equal(install.workflowYaml.includes("dci_"), false);
  });

  it("observes the repository's own default branch, not an assumed one", () => {
    const install = buildInstallInstructions({ repository, actionRef: PINNED, apiOrigin: "https://api.diffci.test" });
    assert.ok(install.workflowYaml.includes("branches: [trunk]"));
  });

  it("warns when the action reference it was configured with is not pinned", () => {
    const unpinned = buildInstallInstructions({ repository, actionRef: "adityankale190895/DiffCI.com@main", apiOrigin: "https://api.diffci.test" });
    assert.ok(unpinned.warning);
    assert.match(unpinned.warning, /not pinned/);

    const pinned = buildInstallInstructions({ repository, actionRef: PINNED, apiOrigin: "https://api.diffci.test" });
    assert.equal(pinned.warning, undefined);
  });

  it("generates a workflow that passes DiffCI's own non-interference guard", () => {
    const install = buildInstallInstructions({ repository, actionRef: PINNED, apiOrigin: "https://api.diffci.test" });
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
