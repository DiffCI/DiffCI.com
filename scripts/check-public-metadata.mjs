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
equal("package version", pkg.version, manifest.packageVersion);
equal("package license", pkg.license, manifest.license);
equal("package Node requirement", pkg.engines?.node, manifest.nodeRequirement);
equal("lockfile root version", lock.version, manifest.packageVersion);
equal("lockfile package version", lock.packages?.[""]?.version, manifest.packageVersion);
equal("MCP server version", server.version, manifest.packageVersion);
equal("MCP npm package", server.packages?.[0]?.identifier, manifest.packageName);
equal("MCP npm version", server.packages?.[0]?.version, manifest.packageVersion);
contains("Action name", action, `name: ${manifest.actionName}`);
contains("Action description", action, `description: ${manifest.actionDescription}`);

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
  contains(`${path} Action release label`, read(path), manifest.actionVersion);
}
contains("README Marketplace link", read("README.md"), manifest.marketplaceUrl);
contains("README npm command", read("README.md"), `npx ${manifest.packageName}@latest check`);
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
  failures.push(`Git tag ${manifest.actionVersion}: tag is missing from this checkout`);
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
