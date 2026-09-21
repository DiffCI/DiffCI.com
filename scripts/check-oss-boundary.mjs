#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const OSS_PACKAGE_NAME = "@diffci.com/diffci";
const npmCommand = process.platform === "win32" ? "cmd.exe" : "npm";
const npmPackArgs =
  process.platform === "win32"
    ? ["/d", "/c", "npm", "pack", "--ignore-scripts", "--dry-run", "--json"]
    : ["pack", "--ignore-scripts", "--dry-run", "--json"];

const ALLOWED_PACKAGE_PREFIXES = [
  "action.yml",
  "dist-client/src/client/",
  "node_modules/",
  "README.md",
  "SECURITY.md",
  "SUPPORT.md",
  "COMMERCIAL.md",
  "docs/distribution.md",
  "docs/npm-adoption.md",
  "docs/language-support.md",
  "LICENSE",
  "package.json",
];

const FORBIDDEN_PACKAGE_PATTERNS = [
  /^src\/(?:analysis-fanout|auth|install|ledger|product|research|runner|shadow|usage|validation-env)\//,
  /^scripts\/(?:build-agent|deploy-|diffci-shadow|generate-shadow-report|migrate-product-db|upload-shadow-source)/,
  /^ops\//,
  /^site\//,
  /^docs\/(?:evidence|funding|growth|research)\//,
  /^wrangler\./,
  /(?:secret|token|billing|ledger|customer|proprietary)/i,
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isAllowed(path) {
  return ALLOWED_PACKAGE_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix));
}

function isForbidden(path) {
  if (path.startsWith("node_modules/")) return false;
  return FORBIDDEN_PACKAGE_PATTERNS.some((pattern) => pattern.test(path));
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
assert(pkg.name === OSS_PACKAGE_NAME, `package name must stay ${OSS_PACKAGE_NAME}`);
assert(pkg.private === false, "the OSS package must remain publishable");

for (const entry of pkg.files ?? []) {
  assert(
    ALLOWED_PACKAGE_PREFIXES.some((prefix) => entry === prefix || prefix.startsWith(`${entry.replace(/\/$/, "")}/`)),
    `package.json files entry is outside the OSS allowlist: ${entry}`,
  );
  assert(!isForbidden(entry), `package.json files entry crosses the proprietary boundary: ${entry}`);
}

const packJson = execFileSync(npmCommand, npmPackArgs, {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
const pack = JSON.parse(packJson)[0];
for (const file of pack.files ?? []) {
  const path = file.path.replace(/\\/g, "/").replace(/^package\//, "");
  assert(isAllowed(path), `npm package contains a non-OSS path: ${path}`);
  assert(!isForbidden(path), `npm package contains proprietary/control-plane path: ${path}`);
}

console.log(`OSS boundary passed: ${pack.name}@${pack.version} contains ${pack.files.length} allowed file(s).`);
