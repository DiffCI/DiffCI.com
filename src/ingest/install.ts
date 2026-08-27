/**
 * Self-serve installation instructions.
 *
 * The exit criterion starts "a stranger self-serves". That is not a page of prose - it is the moment
 * after someone connects a repository, when the product either hands them the exact file to commit and
 * the exact secrets to set, or asks them to talk to a human. This module is the former.
 *
 * DISTRIBUTION (2026-08-27). DiffCI is proprietary and source-private, so it is not a third-party
 * `uses:` Action: that would require a public repository holding either the source or a committed
 * bundle. The generated workflow instead installs an authenticated, version-and-integrity-pinned
 * package and runs it. The pin is the security property, and it is enforced by the type of
 * `agentArtifact` - see ./agent-artifact.ts.
 *
 * The generated workflow still passes DiffCI's own non-interference guard
 * (src/client/workflow-guard.ts): its own job, `continue-on-error: true`, `contents: read`,
 * `fetch-depth: 0`, nothing depending on it. Generating anything else would mean the product's own
 * onboarding produced an installation its own checker rejects.
 *
 * No raw credential appears in the generated YAML. Both tokens go in repository secrets and the YAML
 * references them, so the file committed to their repository - and reviewed in a pull request - carries
 * nothing sensitive.
 */
import type { Repository } from "../product/types.js";
import type { PinnedAgentArtifact } from "./agent-artifact.js";

export interface InstallInstructions {
  /** The GitHub Actions secret holding the ingest credential. */
  secretName: string;
  /** The GitHub Actions secret holding the registry credential used to install the agent. */
  registrySecretName: string;
  /** Where the generated file goes in their repository. */
  workflowPath: string;
  workflowYaml: string;
  /**
   * Human-readable identity of the pinned agent, e.g. "@diffci/observer@1.4.2". Always immutable and
   * integrity-verifiable: no code path produces these instructions from a range or a tag, so there is
   * no "unpinned but warned" variant of this type.
   */
  agent: string;
  /** The exact integrity value a customer can check against, when the artifact kind carries one. */
  agentIntegrity?: string;
  /** Where reports are sent. */
  ingestUrl: string;
  /** Ordered, imperative steps. Each one is something the person does, not something DiffCI does. */
  steps: string[];
}

export interface BuildInstallInstructionsInput {
  repository: Pick<Repository, "ownerName" | "defaultBranch">;
  /**
   * The agent to install, already proven immutable and integrity-verifiable. Typed as
   * PinnedAgentArtifact rather than string so that generating instructions naming a semver range or a
   * dist-tag is not merely discouraged but unrepresentable - the only producer is parseAgentArtifact()
   * in ./agent-artifact.ts, and its brand is not exported.
   */
  agentArtifact: PinnedAgentArtifact;
  /** Origin of this API, e.g. "https://app.diffci.com". */
  apiOrigin: string;
  secretName?: string;
  registrySecretName?: string;
  workflowFileName?: string;
}

const DEFAULT_SECRET_NAME = "DIFFCI_TOKEN";
const DEFAULT_REGISTRY_SECRET_NAME = "DIFFCI_REGISTRY_TOKEN";
const DEFAULT_WORKFLOW_FILE = "diffci-observe.yml";

/** The install+run steps for one artifact kind. Kept separate so a new kind is an added branch here. */
function agentSteps(artifact: PinnedAgentArtifact, registrySecretName: string): string {
  if (artifact.kind === "oci") {
    return `      - name: Run DiffCI
        run: |
          docker run --rm \\
            -v "\${{ github.workspace }}:/workspace:ro" \\
            -e DIFFCI_API_URL -e DIFFCI_TOKEN \\
            ${artifact.image}@${artifact.digest} observe --repo /workspace`;
  }

  const scope = artifact.name.startsWith("@") ? artifact.name.split("/")[0]! : undefined;

  // EVERYTHING HERE HAPPENS OUTSIDE THE CHECKOUT, and that is the point rather than a detail.
  //
  // `npm install` in the workspace would create node_modules inside the repository DiffCI is about to
  // measure, and writing an .npmrc there would leave a credential file in it. Either one changes the
  // thing being observed, which is the one promise this installation makes. RUNNER_TEMP is outside the
  // checkout, is cleaned up by the runner, and is where the report already goes.
  //
  // The registry token is written by the shell from an environment variable rather than passed as an
  // argument: an argv is readable by every other process on the runner and shows up in traces.
  return `      # Installs the pinned agent OUTSIDE the checkout, so nothing appears inside the repository
      # being observed. The version is exact: a range would resolve to whatever is newest when this
      # runs, letting the code executing here change without this file changing.
      - name: Install DiffCI
        shell: bash
        run: |
          set -euo pipefail
          {${scope ? `\n            echo "${scope}:registry=https://registry.npmjs.org/"` : ""}
            echo "//registry.npmjs.org/:_authToken=\${DIFFCI_REGISTRY_TOKEN}"
          } > "\${RUNNER_TEMP}/.npmrc"
          npm install --userconfig "\${RUNNER_TEMP}/.npmrc" --prefix "\${RUNNER_TEMP}/diffci" \\
            --no-audit --no-fund ${artifact.name}@${artifact.version}
        env:
          DIFFCI_REGISTRY_TOKEN: \${{ secrets.${registrySecretName} }}

      # A block scalar, not an inline value. An inline \`run:\` beginning with a quote is parsed by YAML
      # as a quoted scalar with trailing content after the closing quote, which makes the whole
      # workflow file unparseable - and an unparseable workflow is one DiffCI's own guard cannot check.
      - name: Run DiffCI
        shell: bash
        run: |
          "\${RUNNER_TEMP}/diffci/node_modules/.bin/diffci" observe`;
}

export function buildInstallInstructions(input: BuildInstallInstructionsInput): InstallInstructions {
  const secretName = input.secretName ?? DEFAULT_SECRET_NAME;
  const registrySecretName = input.registrySecretName ?? DEFAULT_REGISTRY_SECRET_NAME;
  const workflowPath = `.github/workflows/${input.workflowFileName ?? DEFAULT_WORKFLOW_FILE}`;
  const ingestUrl = `${input.apiOrigin.replace(/\/+$/, "")}/v1/ingest/observations`;
  const defaultBranch = input.repository.defaultBranch || "main";
  const artifact = input.agentArtifact;

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
    env:
      DIFFCI_API_URL: ${ingestUrl}
      DIFFCI_TOKEN: \${{ secrets.${secretName} }}
    steps:
      - uses: actions/checkout@v4
        with:
          # DiffCI compares two commits; the default shallow checkout does not contain the base one.
          fetch-depth: 0

${agentSteps(artifact, registrySecretName)}
`;

  const steps = [
    `Add a repository secret named ${registrySecretName} with the DiffCI registry token shown once above (Settings -> Secrets and variables -> Actions -> New repository secret). It is read-only and only permits installing the DiffCI agent.`,
    `Add a second repository secret named ${secretName} with the ingest token shown once above.`,
    `Commit the file below as ${workflowPath}.`,
    `Open a pull request, or push to ${defaultBranch}. The job appears as "DiffCI observation" and the report is sent here.`,
    `Nothing else changes: no existing job is modified, and no job waits on this one.`,
    `The agent is pinned to ${artifact.display}. Keep it pinned - DiffCI will tell you when a new version is available, and upgrading is a deliberate change to this file.`,
  ];

  return {
    secretName,
    registrySecretName,
    workflowPath,
    workflowYaml,
    agent: artifact.display,
    agentIntegrity: artifact.kind === "npm" ? artifact.integrity : artifact.digest,
    ingestUrl,
    steps,
  };
}
