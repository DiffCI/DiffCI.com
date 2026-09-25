import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const readJson = (path) => JSON.parse(read(path));
const writeJson = (path, value) => writeFileSync(join(root, path), `${JSON.stringify(value, null, 2)}\n`, "utf8");

function replaceRequired(path, pattern, replacement, label) {
  const before = read(path);
  if (!pattern.test(before)) throw new Error(`${path}: could not find ${label}`);
  pattern.lastIndex = 0;
  const after = before.replace(pattern, replacement);
  writeFileSync(join(root, path), after, "utf8");
}

const [requestedVersion, requestedActionSha, ...extra] = process.argv.slice(2);
if (extra.length > 0 || (requestedVersion && !requestedActionSha) || (!requestedVersion && requestedActionSha)) {
  throw new Error("Usage: npm run release:sync -- [<package-version> <qualified-action-sha>]");
}

const manifest = readJson("release-manifest.json");
if (requestedVersion) manifest.packageVersion = requestedVersion;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.packageVersion)) {
  throw new Error(`Invalid package version: ${manifest.packageVersion}`);
}
if (requestedActionSha) manifest.actionSha = requestedActionSha;
if (!/^[0-9a-f]{40}$/.test(manifest.actionSha)) throw new Error(`Invalid Action SHA: ${manifest.actionSha}`);
manifest.actionVersion = `v${manifest.packageVersion}`;
writeJson("release-manifest.json", manifest);

const pkg = readJson("package.json");
pkg.version = manifest.packageVersion;
writeJson("package.json", pkg);

const lock = readJson("package-lock.json");
lock.version = manifest.packageVersion;
lock.packages[""].version = manifest.packageVersion;
writeJson("package-lock.json", lock);

const server = readJson("server.json");
server.version = manifest.packageVersion;
for (const packageEntry of server.packages ?? []) {
  if (packageEntry.identifier === manifest.packageName) packageEntry.version = manifest.packageVersion;
}
writeJson("server.json", server);
replaceRequired(
  "src/site/mcp-endpoint.ts",
  /(export const MCP_SERVER_INFO = \{ name: "[^"]+", version: ")\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(" \};)/,
  `$1${manifest.packageVersion}$2`,
  "the HTTPS MCP server version",
);

const smithery = readJson("packaging/smithery/manifest.json");
smithery.version = manifest.packageVersion;
writeJson("packaging/smithery/manifest.json", smithery);

replaceRequired(
  ".github/workflows/diffci.yml",
  /(@diffci\.com\/diffci@)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g,
  `$1${manifest.packageVersion}`,
  "the pinned npm package version",
);
replaceRequired(
  "docs/adoption-metrics.md",
  /(\| npm latest version \| `)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(` \|)/g,
  `$1${manifest.packageVersion}$2`,
  "the npm latest-version row",
);
replaceRequired(
  "site/index.html",
  /("softwareVersion": ")\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(")/g,
  `$1${manifest.packageVersion}$2`,
  "SoftwareApplication.softwareVersion",
);
replaceRequired(
  "site/mcp-server.html",
  /("softwareVersion":")\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(")/g,
  `$1${manifest.packageVersion}$2`,
  "MCP SoftwareApplication.softwareVersion",
);

const actionPinFiles = [
  "README.md",
  "site/index.html",
  "docs/agent-adoption-kit.md",
  "docs/context7/github-action.md",
  "docs/distribution.md",
  "docs/npm-adoption.md",
];
for (const path of actionPinFiles) {
  replaceRequired(
    path,
    /(uses:\s*DiffCI\/DiffCI\.com@)[0-9a-f]{40}/g,
    `$1${manifest.actionSha}`,
    "a SHA-pinned DiffCI Action example",
  );
}

const actionLabelFiles = [
  "README.md",
  "site/index.html",
  "docs/agent-adoption-kit.md",
  "docs/context7/github-action.md",
  "docs/distribution.md",
];
for (const path of actionLabelFiles) {
  replaceRequired(
    path,
    /\bv\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/g,
    manifest.actionVersion,
    "a DiffCI Action release label",
  );
}

console.log(`Synchronized package ${manifest.packageVersion}, Action ${manifest.actionVersion}, and ${manifest.actionSha}.`);
