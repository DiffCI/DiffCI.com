import assert from "node:assert/strict";
import test from "node:test";
import worker, { type SiteEnv } from "../../src/site/site-worker.js";

function env(): SiteEnv {
  return {
    ASSETS: {
      async fetch(request: Request) {
        return new Response(new URL(request.url).pathname, { status: 200 });
      },
    },
  };
}

test("normalizes scheme and www host permanently", async () => {
  const www = await worker.fetch(new Request("https://www.diffci.com/docs/codex?ref=x"), env());
  assert.equal(www.status, 301);
  assert.equal(www.headers.get("location"), "https://diffci.com/docs/codex?ref=x");

  const forwardedHttp = await worker.fetch(
    new Request("https://diffci.com/", { headers: { "cf-visitor": JSON.stringify({ scheme: "http" }) } }),
    env(),
  );
  assert.equal(forwardedHttp.status, 301);
  assert.equal(forwardedHttp.headers.get("location"), "https://diffci.com/");
});

test("redirects legacy document variants to one clean URL", async () => {
  const html = await worker.fetch(new Request("https://diffci.com/docs/codex.html?source=old"), env());
  assert.equal(html.status, 308);
  assert.equal(html.headers.get("location"), "https://diffci.com/docs/codex?source=old");

  const rootIndex = await worker.fetch(new Request("https://diffci.com/index.html"), env());
  assert.equal(rootIndex.status, 308);
  assert.equal(rootIndex.headers.get("location"), "https://diffci.com/");

  const slash = await worker.fetch(new Request("https://diffci.com/docs/codex/"), env());
  assert.equal(slash.status, 308);
  assert.equal(slash.headers.get("location"), "https://diffci.com/docs/codex");

  const combined = await worker.fetch(new Request("https://www.diffci.com/docs/codex.html"), env());
  assert.equal(combined.status, 301);
  assert.equal(combined.headers.get("location"), "https://diffci.com/docs/codex");
});

test("passes canonical documents and assets through unchanged", async () => {
  const document = await worker.fetch(new Request("https://diffci.com/docs/codex"), env());
  assert.equal(document.status, 200);
  assert.equal(await document.text(), "/docs/codex");

  const asset = await worker.fetch(new Request("https://diffci.com/assets/diffci-mark.svg"), env());
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), "/assets/diffci-mark.svg");

});

const mcpHeaders = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

async function mcp(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return worker.fetch(new Request("https://diffci.com/mcp", {
    method: "POST",
    headers: { ...mcpHeaders, ...headers },
    body: JSON.stringify(body),
  }), env());
}

test("serves a stateless Streamable HTTP MCP endpoint", async () => {
  const initialized = await mcp({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  });
  assert.equal(initialized.status, 200);
  assert.match(initialized.headers.get("content-type") ?? "", /^application\/json/);
  const initBody = await initialized.json() as { result?: { protocolVersion?: string; serverInfo?: { name?: string } } };
  assert.equal(initBody.result?.protocolVersion, "2025-11-25");
  assert.equal(initBody.result?.serverInfo?.name, "io.github.adityankale190895/diffci");

  const listed = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, {
    "MCP-Protocol-Version": "2025-11-25",
  });
  const listBody = await listed.json() as { result?: { tools?: Array<{ name?: string }> } };
  assert.deepEqual(listBody.result?.tools?.map((tool) => tool.name), [
    "diffci_validation_plan",
    "diffci_interpret_report",
    "diffci_verify_workflow_text",
  ]);

  const called = await mcp({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "diffci_validation_plan", arguments: { action: "observe", repo: "/work/repo" } },
  });
  const callBody = await called.json() as { result?: { structuredContent?: { arguments?: string[]; runsTests?: boolean } } };
  assert.deepEqual(callBody.result?.structuredContent?.arguments, [
    "@diffci.com/diffci@latest", "observe", "--no-send", "--repo", "/work/repo",
  ]);
  assert.equal(callBody.result?.structuredContent?.runsTests, false);
});

test("interprets reports and checks submitted workflow text without repository access", async () => {
  const interpreted = await mcp({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "diffci_interpret_report",
      arguments: {
        report: {
          schema: "diffci.observation.v1",
          producedAt: "2026-09-25T00:00:00.000Z",
          status: "REFUSED",
          stage: "eligibility",
          reason: "unsupported repository",
          payload: { includesFileContents: false, includesCredentials: false },
          nonInterference: { worktreeUnchanged: true, reportWrittenOutsideRepository: true, workflowFindings: [] },
        },
      },
    },
  });
  const interpretedBody = await interpreted.json() as {
    result?: { structuredContent?: { valid?: boolean; status?: string; nextAction?: string } };
  };
  assert.equal(interpretedBody.result?.structuredContent?.valid, true);
  assert.equal(interpretedBody.result?.structuredContent?.status, "REFUSED");
  assert.match(interpretedBody.result?.structuredContent?.nextAction ?? "", /normal validation/);

  const workflow = await mcp({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "diffci_verify_workflow_text",
      arguments: {
        workflow: `jobs:\n  diffci:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npx @diffci.com/diffci@latest observe\n  deploy:\n    needs: diffci\n    runs-on: ubuntu-latest\n    steps: []\n`,
      },
    },
  });
  const workflowBody = await workflow.json() as {
    result?: { structuredContent?: { safe?: boolean; findings?: Array<{ code?: string }> } };
  };
  assert.equal(workflowBody.result?.structuredContent?.safe, false);
  assert.deepEqual(workflowBody.result?.structuredContent?.findings?.map((finding) => finding.code), [
    "JOB_IS_A_DEPENDENCY",
    "JOB_NOT_CONTINUE_ON_ERROR",
    "AGENT_NOT_PINNED",
  ]);
});

test("publishes cacheable MCP server-card and AI catalog discovery documents", async () => {
  const card = await worker.fetch(new Request("https://diffci.com/mcp/server-card"), env());
  assert.equal(card.status, 200);
  assert.match(card.headers.get("content-type") ?? "", /^application\/mcp-server-card\+json/);
  assert.equal(card.headers.get("access-control-allow-origin"), "*");
  const etag = card.headers.get("etag");
  assert.ok(etag);
  const cardBody = await card.json() as { name?: string; remotes?: Array<{ url?: string }> };
  assert.equal(cardBody.name, "io.github.adityankale190895/diffci");
  assert.equal(cardBody.remotes?.[0]?.url, "https://diffci.com/mcp");

  const unchanged = await worker.fetch(new Request("https://diffci.com/mcp/server-card", {
    headers: { "If-None-Match": etag },
  }), env());
  assert.equal(unchanged.status, 304);

  const catalog = await worker.fetch(new Request("https://diffci.com/.well-known/ai-catalog.json"), env());
  assert.match(catalog.headers.get("content-type") ?? "", /^application\/ai-catalog\+json/);
  const catalogBody = await catalog.json() as { entries?: Array<{ url?: string }> };
  assert.equal(catalogBody.entries?.[0]?.url, "https://diffci.com/mcp/server-card");
});

test("implements HTTP and Origin guardrails for the MCP endpoint", async () => {
  const get = await worker.fetch(new Request("https://diffci.com/mcp", {
    headers: { Accept: "text/event-stream" },
  }), env());
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST, OPTIONS");

  const notification = await mcp({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  assert.equal(notification.status, 202);
  assert.equal(await notification.text(), "");

  const clientResponse = await mcp({ jsonrpc: "2.0", id: 99, result: {} });
  assert.equal(clientResponse.status, 202);
  assert.equal(await clientResponse.text(), "");

  const badOrigin = await mcp({ jsonrpc: "2.0", id: 1, method: "ping" }, { Origin: "http://localhost:3000" });
  assert.equal(badOrigin.status, 403);

  const browser = await mcp({ jsonrpc: "2.0", id: 1, method: "ping" }, { Origin: "https://example-client.test" });
  assert.equal(browser.status, 200);
  assert.equal(browser.headers.get("access-control-allow-origin"), "https://example-client.test");

  const redirected = await worker.fetch(new Request("http://diffci.com/mcp", {
    method: "POST",
    headers: mcpHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  }), env());
  assert.equal(redirected.status, 308);
  assert.equal(redirected.headers.get("location"), "https://diffci.com/mcp");
});
