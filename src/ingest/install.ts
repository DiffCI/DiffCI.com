/**
 * Self-serve installation instructions (Phase 03, 2026-08-26).
 *
 * Phase 03's exit criterion starts "a stranger self-serves". That is not a page of prose - it is the
 * moment after someone connects a repository, when the product either hands them the exact file to
 * commit and the exact secret to set, or asks them to talk to a human. This module is the former.
 *
 * The generated workflow is the same shape as examples/diffci-observe.yml and passes the same guard
 * (src/client/workflow-guard.ts): its own job, `continue-on-error: true`, `contents: read`, a pinned
 * action, `fetch-depth: 0`. Generating anything else here would mean the product's own onboarding
 * produced an installation its own checker rejects.
 *
 * The raw token never appears in the generated YAML. It goes in a repository secret, and the YAML
 * references the secret - so the file that gets committed to their repository, and reviewed in a pull
 * request, carries no credential.
 */
import type { Repository } from "../product/types.js";

export interface InstallInstructions {
  /** The GitHub Actions secret the workflow reads. */
  secretName: string;
  /** Where the generated file goes in their repository. */
  workflowPath: string;
  workflowYaml: string;
  /** `owner/repo@ref` for the DiffCI action. */
  actionRef: string;
  /** Where reports are sent. */
  ingestUrl: string;
  /** Ordered, imperative steps. Each one is something the person does, not something DiffCI does. */
  steps: string[];
  /**
   * Set when the configured action reference is not pinned to a commit SHA. Surfaced rather than
   * silently corrected: the product cannot pin on the customer's behalf, and an unpinned action means
   * the code running in their CI can change without their repository changing.
   */
  warning?: string;
}

export interface BuildInstallInstructionsInput {
  repository: Pick<Repository, "ownerName" | "defaultBranch">;
  /** e.g. "adityankale190895/DiffCI.com@<40-hex sha>". */
  actionRef: string;
  /** Origin of this API, e.g. "https://diffci-product.example.workers.dev". */
  apiOrigin: string;
  secretName?: string;
  workflowFileName?: string;
}

const DEFAULT_SECRET_NAME = "DIFFCI_TOKEN";
const DEFAULT_WORKFLOW_FILE = "diffci-observe.yml";

function isPinnedToSha(actionRef: string): boolean {
  const at = actionRef.lastIndexOf("@");
  return at !== -1 && /^[0-9a-f]{40}$/i.test(actionRef.slice(at + 1));
}

export function buildInstallInstructions(input: BuildInstallInstructionsInput): InstallInstructions {
  const secretName = input.secretName ?? DEFAULT_SECRET_NAME;
  const workflowPath = `.github/workflows/${input.workflowFileName ?? DEFAULT_WORKFLOW_FILE}`;
  const ingestUrl = `${input.apiOrigin.replace(/\/+$/, "")}/v1/ingest/observations`;
  const defaultBranch = input.repository.defaultBranch || "main";

  const workflowYaml = `# DiffCI observation. One job that only looks: it runs no tests, skips none, and nothing
# depends on it. Generated for ${input.repository.ownerName}.
name: DiffCI (observation only)

on:
  pull_request:
  push:
    branches: [${defaultBranch}]

permissions:
  contents: read

jobs:
  diffci:
    name: DiffCI observation
    runs-on: ubuntu-latest
    timeout-minutes: 20
    # Keeps a DiffCI failure out of this workflow's own conclusion, which is what a required status
    # check and a merge queue read.
    continue-on-error: true
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          # DiffCI compares two commits; the default shallow checkout does not contain the base one.
          fetch-depth: 0
      - uses: ${input.actionRef}
        with:
          api-url: ${ingestUrl}
          api-token: \${{ secrets.${secretName} }}
`;

  const steps = [
    `Add a repository secret named ${secretName} with the token shown once above (Settings -> Secrets and variables -> Actions -> New repository secret).`,
    `Commit the file below as ${workflowPath}.`,
    `Open a pull request, or push to ${defaultBranch}. The job appears as "DiffCI observation" and the report is uploaded as a workflow artifact as well as sent here.`,
    "Nothing else changes: no existing job is modified, and no job waits on this one.",
  ];

  return {
    secretName,
    workflowPath,
    workflowYaml,
    actionRef: input.actionRef,
    ingestUrl,
    steps,
    warning: isPinnedToSha(input.actionRef)
      ? undefined
      : `The action reference "${input.actionRef}" is not pinned to a 40-character commit SHA, so the code that runs in your CI can change without your repository changing. Pin it before starting an observation window.`,
  };
}
