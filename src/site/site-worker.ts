/**
 * diffci.com site Worker (2026-09-05). The site was assets-only; a script in front of the assets exists
 * for exactly three things a static deployment cannot do:
 *   1. plain http:// is answered with a 301 to https:// (Always-Use-HTTPS at the zone level is a
 *      dashboard setting the code cannot make; the Worker enforces it regardless);
 *   2. www.diffci.com is answered with a 301 to the apex (the www custom domain used to 522);
 *   3. nothing else - every other request is served from the ./site assets unchanged.
 */
export interface SiteEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

export default {
  async fetch(request: Request, env: SiteEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.protocol === "http:" || url.hostname === "www.diffci.com") {
      url.protocol = "https:";
      if (url.hostname === "www.diffci.com") url.hostname = "diffci.com";
      return Response.redirect(url.toString(), 301);
    }
    return env.ASSETS.fetch(request);
  },
};
