import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const json = (path) => JSON.parse(read(path));
const manifest = json("release-manifest.json");
const pkg = json("package.json");
const lock = json("package-lock.json");
const server = json("server.json");
const smithery = json("packaging/smithery/manifest.json");
const action = read("action.yml");
const failures = [];

function equal(label, actual, expected) {
  if (actual !== expected) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function contains(label, body, expected) {
  if (!body.includes(expected)) failures.push(`${label}: missing ${JSON.stringify(expected)}`);
}

equal("package name", pkg.name, manifest.packageName);
equal("package description", pkg.description, manifest.packageDescription);
equal("package homepage", pkg.homepage, `${manifest.homepage}/`);
equal("package version", pkg.version, manifest.packageVersion);
equal("package and Action release versions", manifest.actionVersion, `v${manifest.packageVersion}`);
equal("package license", pkg.license, manifest.license);
equal("package Node requirement", pkg.engines?.node, manifest.nodeRequirement);
equal("lockfile root version", lock.version, manifest.packageVersion);
equal("lockfile package version", lock.packages?.[""]?.version, manifest.packageVersion);
equal("MCP server version", server.version, manifest.packageVersion);
equal("MCP npm package", server.packages?.[0]?.identifier, manifest.packageName);
equal("MCP npm version", server.packages?.[0]?.version, manifest.packageVersion);
equal("MCP HTTPS transport", server.remotes?.[0]?.type, "streamable-http");
equal("MCP HTTPS endpoint", server.remotes?.[0]?.url, `${manifest.homepage}/mcp`);
contains(
  "MCP HTTPS server version",
  read("src/site/mcp-endpoint.ts"),
  `export const MCP_SERVER_INFO = { name: "${server.name}", version: "${manifest.packageVersion}" };`,
);
equal("MCP package namespace", pkg.mcpName, server.name);
equal("MCP landing page", server.websiteUrl, `${manifest.homepage}/mcp-server`);
const mcpPublishWorkflow = read(".github/workflows/publish-mcp-registry.yml");
contains("MCP release automation main guard", mcpPublishWorkflow, "if: github.ref == 'refs/heads/main'");
contains("MCP release automation protected environment", mcpPublishWorkflow, "environment: mcp-registry-publish");
contains("MCP release automation publish", mcpPublishWorkflow, "./mcp-publisher publish server.json");
contains("MCP release automation verification", mcpPublishWorkflow, "npm run registry:verify");
equal("Smithery package version", smithery.version, manifest.packageVersion);
contains("Action name", action, `name: ${manifest.actionName}`);
contains("Action description", action, `description: ${manifest.actionDescription}`);
equal("release sync command", pkg.scripts?.["release:sync"], "node scripts/sync-public-metadata.mjs");
const workflow = read(".github/workflows/diffci.yml");
const workflowPackageVersions = [...workflow.matchAll(/@diffci\.com\/diffci@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g)].map((match) => match[1]);
if (workflowPackageVersions.length === 0) failures.push("DiffCI workflow: no exact npm version found");
for (const version of workflowPackageVersions) equal("DiffCI workflow npm version", version, manifest.packageVersion);
contains(
  "DiffCI workflow explicit executable invocation",
  workflow,
  `npx --yes --package "${manifest.packageName}@${manifest.packageVersion}" diffci observe --repo "$GITHUB_WORKSPACE" --no-send`,
);
contains("DiffCI workflow isolated package canary", workflow, 'cd "$RUNNER_TEMP"');
contains("adoption metrics npm latest", read("docs/adoption-metrics.md"), `| \`${manifest.packageVersion}\` |`);
contains("homepage software version", read("site/index.html"), `"softwareVersion": "${manifest.packageVersion}"`);
contains("MCP landing software version", read("site/mcp-server.html"), `"softwareVersion":"${manifest.packageVersion}"`);

const publicDocs = [
  "README.md",
  "site/index.html",
  "docs/agent-adoption-kit.md",
  "docs/context7/github-action.md",
  "docs/distribution.md",
  "docs/npm-adoption.md",
];
const pinPattern = /uses:\s*DiffCI\/DiffCI\.com@([0-9a-f]{40})/g;
for (const path of publicDocs) {
  const body = read(path);
  const pins = [...body.matchAll(pinPattern)].map((match) => match[1]);
  if (pins.length === 0) failures.push(`${path}: no SHA-pinned DiffCI Action example found`);
  for (const pin of pins) equal(`${path} Action pin`, pin, manifest.actionSha);
}

for (const path of ["README.md", "site/index.html", "docs/context7/github-action.md", "docs/distribution.md", "docs/agent-adoption-kit.md"]) {
  const labels = [...read(path).matchAll(/\bv\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/g)].map((match) => match[0]);
  if (labels.length === 0) failures.push(`${path}: no Action release label found`);
  for (const label of labels) equal(`${path} Action release label`, label, manifest.actionVersion);
}
contains("README Marketplace link", read("README.md"), manifest.marketplaceUrl);
contains("README npm command", read("README.md"), `npx "${manifest.packageName}@latest" check`);
contains("README Node requirement", read("README.md"), "Node.js 22.5+");

try {
  const taggedSha = execFileSync("git", ["rev-list", "-n", "1", manifest.actionVersion], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", manifest.actionSha, taggedSha], {
      cwd: root,
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch {
    failures.push(`Git tag ${manifest.actionVersion}: ${manifest.actionSha} is not an ancestor of ${taggedSha}`);
  }
} catch {
  // Pull-request checkouts intentionally precede the release tag. In that case,
  // still prove the immutable Action pin is part of the commit being reviewed.
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", manifest.actionSha, "HEAD"], {
      cwd: root,
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch {
    failures.push(`Git tag ${manifest.actionVersion}: tag is missing and ${manifest.actionSha} is not an ancestor of HEAD`);
  }
}

async function checkRemote() {
  const npmResponse = await fetch(`https://registry.npmjs.org/${encodeURIComponent(manifest.packageName)}`);
  if (!npmResponse.ok) failures.push(`npm package metadata: HTTP ${npmResponse.status}`);
  else equal("npm latest", (await npmResponse.json())["dist-tags"]?.latest, manifest.packageVersion);

  const headers = { Accept: "application/vnd.github+json", "User-Agent": "diffci-release-drift-check" };
  const repoResponse = await fetch(`https://api.github.com/repos/${manifest.repository}`, { headers });
  if (!repoResponse.ok) failures.push(`GitHub repository metadata: HTTP ${repoResponse.status}`);
  else {
    const repo = await repoResponse.json();
    equal("GitHub About description", repo.description, manifest.repositoryDescription);
    equal("GitHub About homepage", repo.homepage, manifest.homepage);
  }

  const releaseResponse = await fetch(`https://api.github.com/repos/${manifest.repository}/releases/tags/${manifest.actionVersion}`, { headers });
  if (!releaseResponse.ok) failures.push(`GitHub release ${manifest.actionVersion}: HTTP ${releaseResponse.status}`);
  else {
    const release = await releaseResponse.json();
    equal("GitHub release tag", release.tag_name, manifest.actionVersion);
    equal("GitHub release draft state", release.draft, false);
  }

  const marketplaceResponse = await fetch(manifest.marketplaceUrl, {
    headers: { Accept: "text/html", "User-Agent": "diffci-release-drift-check" },
  });
  if (!marketplaceResponse.ok) failures.push(`GitHub Marketplace: HTTP ${marketplaceResponse.status}`);
  else contains("GitHub Marketplace version", await marketplaceResponse.text(), manifest.actionVersion);
}

if (process.argv.includes("--remote")) {
  try {
    await checkRemote();
  } catch (error) {
    failures.push(`remote metadata check failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failures.length > 0) {
  console.error("Public metadata drift detected:\n" + failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}

console.log(`Public metadata is aligned at ${manifest.packageVersion} (${manifest.actionSha.slice(0, 12)}).`);
