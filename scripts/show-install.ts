/** Prints the workflow onboarding would generate, so it can be reviewed as a customer sees it. */
import { buildInstallInstructions } from "../src/ingest/install.js";
import { parseAgentArtifact } from "../src/ingest/agent-artifact.js";

const artifact = parseAgentArtifact(process.argv[2] ?? `npm:@diffci/observer@1.4.2#sha512-${"A".repeat(86)}==`);
if (!artifact.ok) throw new Error(`${artifact.rejection}: ${artifact.message}`);
const install = buildInstallInstructions({
  repository: { ownerName: "acme/checkout", defaultBranch: "main" },
  agentArtifact: artifact.artifact,
  apiOrigin: "https://app.diffci.com",
});
console.log(install.workflowYaml);
console.log("--- steps ---");
install.steps.forEach((step, i) => console.log(`${i + 1}. ${step}`));
