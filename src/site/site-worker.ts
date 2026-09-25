/**
 * diffci.com site Worker (2026-09-05). The site was assets-only; a script in front of the assets exists
 * for URL normalization that static asset serving cannot do on its own:
 *   1. plain http:// is answered with a 301 to https:// (Always-Use-HTTPS at the zone level is a
 *      dashboard setting the code cannot make; the Worker enforces it regardless);
 *   2. www.diffci.com is answered with a 301 to the apex (the www custom domain used to 522);
 *   3. legacy .html and trailing-slash document URLs are permanently redirected to the clean,
 *      extensionless canonical URL;
 *   4. every other request is served from the ./site assets unchanged.
 */
export interface SiteEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
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
    if (movedOrigin || movedDocument) return Response.redirect(url.toString(), movedOrigin ? 301 : 308);
    return env.ASSETS.fetch(request);
  },
};
