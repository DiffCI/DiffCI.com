import { readFileSync } from "node:fs";

const expected = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));
const baseUrl = process.env.MCP_REGISTRY_URL ?? "https://registry.modelcontextprotocol.io";
const response = await fetch(`${baseUrl}/v0.1/servers?search=${encodeURIComponent(expected.name)}`, {
  headers: { Accept: "application/json", "User-Agent": "diffci-registry-verifier" },
});
if (!response.ok) throw new Error(`MCP Registry returned HTTP ${response.status}`);

const payload = await response.json();
const entries = Array.isArray(payload) ? payload : Array.isArray(payload.servers) ? payload.servers : [];
const published = entries
  .map((entry) => entry?.server ?? entry)
  .find((server) => server?.name === expected.name && server?.version === expected.version);

if (!published) {
  console.error(`MCP Registry does not yet contain ${expected.name}@${expected.version}.`);
  process.exit(1);
}

const expectedRemote = expected.remotes?.find((remote) => remote.type === "streamable-http")?.url;
const actualRemote = published.remotes?.find((remote) => remote.type === "streamable-http")?.url;
if (actualRemote !== expectedRemote) {
  throw new Error(`MCP Registry remote mismatch: expected ${expectedRemote}, got ${actualRemote ?? "none"}`);
}

const expectedPackage = expected.packages?.[0];
const actualPackage = published.packages?.find((entry) => entry.identifier === expectedPackage?.identifier);
if (expectedPackage && actualPackage?.version !== expectedPackage.version) {
  throw new Error(`MCP Registry package mismatch: expected ${expectedPackage.identifier}@${expectedPackage.version}`);
}

console.log(`MCP Registry contains ${expected.name}@${expected.version} with ${expectedRemote}.`);
