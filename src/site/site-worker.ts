/**
 * diffci.com site Worker (2026-09-05). The site was assets-only; a script in front of the assets exists
 * for URL normalization that static asset serving cannot do on its own:
 *   1. plain http:// is answered with a 301 to https:// (Always-Use-HTTPS at the zone level is a
 *      dashboard setting the code cannot make; the Worker enforces it regardless);
 *   2. www.diffci.com is answered with a 301 to the apex (the www custom domain used to 522);
 *   3. legacy .html and trailing-slash document URLs are permanently redirected to the clean,
 *      extensionless canonical URL;
 *   4. /mcp and /mcp/v1 serve the stateless Streamable HTTP MCP endpoint;
 *   5. /mcp/server-card and /.well-known/ai-catalog.json expose machine-readable discovery metadata;
 *   6. every other request is served from the ./site assets unchanged.
 */
import { handleMcpRequest, MCP_SERVER_INFO } from "./mcp-endpoint.js";

export interface SiteEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

const discoveryHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, If-None-Match",
  "Access-Control-Expose-Headers": "ETag",
  "Cache-Control": "public, max-age=3600",
};

const serverCard = {
  $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
  name: MCP_SERVER_INFO.name,
  title: "DiffCI",
  description: "Change-aware CI validation, affected-test selection, and workflow safety guidance for coding agents.",
  version: MCP_SERVER_INFO.version,
  websiteUrl: "https://diffci.com/mcp-server",
  repository: { url: "https://github.com/DiffCI/DiffCI.com", source: "github" },
  icons: [{ src: "https://diffci.com/assets/diffci-mark.svg", mimeType: "image/svg+xml", sizes: ["any"] }],
  remotes: [{
    type: "streamable-http",
    url: "https://diffci.com/mcp/v1",
    supportedProtocolVersions: ["2025-03-26", "2025-06-18", "2025-11-25"],
  }],
};

const aiCatalog = {
  specVersion: "1.0",
  entries: [{
    identifier: "urn:air:diffci.com:mcp:diffci",
    type: "application/mcp-server-card+json",
    url: "https://diffci.com/mcp/server-card",
  }],
};

function discoveryResponse(request: Request, body: unknown, contentType: string, etag: string): Response {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: discoveryHeaders });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { ...discoveryHeaders, Allow: "GET, HEAD, OPTIONS" } });
  }
  if (request.headers.get("If-None-Match") === etag) {
    return new Response(null, { status: 304, headers: { ...discoveryHeaders, ETag: etag } });
  }
  return new Response(request.method === "HEAD" ? null : JSON.stringify(body), {
    headers: { ...discoveryHeaders, "Content-Type": `${contentType}; charset=utf-8`, ETag: etag },
  });
}

export default {
  async fetch(request: Request, env: SiteEnv): Promise<Response> {
    const url = new URL(request.url);
    // Cloudflare may present the URL as https even when the visitor connected over http; the original
    // scheme is in the cf-visitor header.
    const visitorScheme = (() => {
      try {
        return (JSON.parse(request.headers.get("cf-visitor") ?? "{}") as { scheme?: string }).scheme;
      } catch {
        return undefined;
      }
    })();
    const movedOrigin = url.protocol === "http:" || visitorScheme === "http" || url.hostname === "www.diffci.com";
    if (movedOrigin) {
      url.protocol = "https:";
      if (url.hostname === "www.diffci.com") url.hostname = "diffci.com";
    }

    // Cloudflare's automatic HTML handling serves extensionless documents, but its generated 307
    // redirects describe the move as temporary. Keep one permanent URL for crawlers, links and users.
    let movedDocument = false;
    if (url.pathname !== "/") {
      if (url.pathname === "/index.html") {
        url.pathname = "/";
        movedDocument = true;
      } else if (url.pathname.endsWith(".html")) {
        url.pathname = url.pathname.slice(0, -5);
        movedDocument = true;
      }
      if (url.pathname !== "/" && url.pathname.endsWith("/")) {
        url.pathname = url.pathname.slice(0, -1);
        movedDocument = true;
      }
    }
    if (movedOrigin || movedDocument) {
      // Preserve POST when a caller accidentally uses http:// for the HTTPS MCP endpoint.
      const isMcpEndpoint = url.pathname === "/mcp" || url.pathname === "/mcp/v1";
      const status = isMcpEndpoint && request.method !== "GET" ? 308 : movedOrigin ? 301 : 308;
      return Response.redirect(url.toString(), status);
    }
    if (url.pathname === "/mcp" || url.pathname === "/mcp/v1") return handleMcpRequest(request);
    if (url.pathname === "/mcp/server-card") {
      return discoveryResponse(request, serverCard, "application/mcp-server-card+json", `"diffci-mcp-${MCP_SERVER_INFO.version}"`);
    }
    if (url.pathname === "/.well-known/ai-catalog.json") {
      return discoveryResponse(request, aiCatalog, "application/ai-catalog+json", `"diffci-ai-catalog-${MCP_SERVER_INFO.version}"`);
    }
    return env.ASSETS.fetch(request);
  },
};
