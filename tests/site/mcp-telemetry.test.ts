import assert from "node:assert/strict";
import { test } from "node:test";
import { handleMcpRequest, type McpUsage } from "../../src/site/mcp-endpoint.js";

test("hosted MCP reports only opted-in bounded metadata, never tool arguments", async () => {
  const events: McpUsage[] = [];
  const request = (consent: boolean, name = "diffci_validation_plan") => new Request("https://diffci.com/mcp", {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(consent ? { "x-diffci-share-usage": "1" } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { repo: "private-repository-path" } } }),
  });
  await handleMcpRequest(request(false), event => events.push(event));
  assert.equal(events.length, 0);
  await handleMcpRequest(request(true), event => events.push(event));
  assert.deepEqual(events[0], { method: "tools/call", tool: "diffci_validation_plan", outcome: "success" });
  await handleMcpRequest(request(true, "private-arbitrary-name"), event => events.push(event));
  assert.deepEqual(events[1], { method: "tools/call", outcome: "error" });
  assert.equal(JSON.stringify(events).includes("private"), false);
});
