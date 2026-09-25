import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const site = path.join(root, "site");

function htmlFiles(directory = site): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return htmlFiles(absolute);
    return entry.name.endsWith(".html") ? [absolute] : [];
  });
}

function fileForUrl(url: URL): string {
  if (url.pathname === "/") return path.join(site, "index.html");
  return path.join(site, `${url.pathname.slice(1)}.html`);
}

function localFileForPath(pathname: string): string {
  if (pathname === "/") return path.join(site, "index.html");
  const relative = pathname.slice(1);
  if (path.extname(relative)) return path.join(site, relative);
  return path.join(site, `${relative}.html`);
}

test("robots.txt advertises the canonical sitemap", () => {
  const robots = readFileSync(path.join(site, "robots.txt"), "utf8");
  assert.match(robots, /^User-agent: \*$/m);
  assert.match(robots, /^Sitemap: https:\/\/diffci\.com\/sitemap\.xml$/m);
});

test("homepage publishes Bing ownership verification", () => {
  const homepage = readFileSync(path.join(site, "index.html"), "utf8");
  assert.match(homepage, /<meta name="msvalidate\.01" content="00B8B6EF3F3F58410655A46BF6E141E2">/);
});

test("homepage credits DentalPresence as DiffCI's original dogfooding target", () => {
  const homepage = readFileSync(path.join(site, "index.html"), "utf8");
  assert.match(homepage, /Original dogfooding target: <a href="https:\/\/dentalpresence\.in\/">DentalPresence<\/a>/);
});

test("site headers enforce HTTPS and disable unused browser capabilities", () => {
  const headers = readFileSync(path.join(site, "_headers"), "utf8");
  assert.match(headers, /^\s*Strict-Transport-Security: max-age=31536000; includeSubDomains$/m);
  assert.match(headers, /^\s*Permissions-Policy: camera=\(\), geolocation=\(\), microphone=\(\)$/m);
});

test("sitemap contains only canonical, indexable, existing HTML pages", () => {
  const sitemap = readFileSync(path.join(site, "sitemap.xml"), "utf8");
  const urls = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => new URL(match[1]!));
  const lastModified = [...sitemap.matchAll(/<lastmod>(.*?)<\/lastmod>/g)].map((match) => match[1]!);
  assert.ok(urls.length >= 10);
  assert.equal(lastModified.length, urls.length, "every sitemap URL needs an accurate freshness signal");
  for (const date of lastModified) assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(new Set(urls.map(String)).size, urls.length, "sitemap URLs must be unique");
  for (const url of urls) {
    assert.equal(url.origin, "https://diffci.com");
    if (url.pathname !== "/") assert.doesNotMatch(url.pathname, /\.html$|\/$/);
    const file = fileForUrl(url);
    assert.ok(existsSync(file), `${url} must resolve to ${path.relative(root, file)}`);
    const body = readFileSync(file, "utf8");
    assert.doesNotMatch(body, /<meta\s+name="robots"\s+content="[^"]*noindex/i, `${url} is noindex`);
    assert.match(body, new RegExp(`<link\\s+rel="canonical"\\s+href="${url.toString().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  }
});

test("IndexNow ownership key is published for automated URL discovery", () => {
  const key = "0d8ca887374f35142a6b1b1cb64ad550";
  assert.equal(readFileSync(path.join(site, `${key}.txt`), "utf8").trim(), key);
});

test("indexable pages have complete search and social metadata", () => {
  for (const file of htmlFiles()) {
    const relative = path.relative(site, file).replaceAll("\\", "/");
    if (relative === "404.html" || relative === "welcome.html") continue;
    const body = readFileSync(file, "utf8");
    assert.equal((body.match(/<h1\b/gi) ?? []).length, 1, `${relative} must have one h1`);
    assert.match(body, /<title>[^<]+<\/title>/i, `${relative} needs a title`);
    assert.match(body, /<meta\s+name="description"\s+content="[^"]+"/i, `${relative} needs a description`);
    assert.match(body, /<link\s+rel="canonical"\s+href="https:\/\/diffci\.com\/[^"]*"/i, `${relative} needs a canonical`);
    assert.match(body, /<meta\s+property="og:image"\s+content="https:\/\/diffci\.com\/assets\/diffci-social-card\.png"/i, `${relative} needs a social image`);
    assert.doesNotMatch(body, /canonical"\s+href="[^"]*\.html"/i, `${relative} canonical must not redirect`);
    assert.doesNotMatch(body, /href="\/[^"]*\.html(?:[#?][^"]*)?"/i, `${relative} internal links must be clean`);
  }
});

test("technical articles expose trustworthy authorship and freshness", () => {
  for (const file of htmlFiles()) {
    const body = readFileSync(file, "utf8");
    if (!body.includes('"@type":"TechArticle"')) continue;
    const relative = path.relative(site, file).replaceAll("\\", "/");
    assert.match(body, /"datePublished":"\d{4}-\d{2}-\d{2}"/, `${relative} needs datePublished`);
    assert.match(body, /"dateModified":"\d{4}-\d{2}-\d{2}"/, `${relative} needs dateModified`);
    assert.match(body, /"author":\{"@type":"Organization","@id":"https:\/\/diffci\.com\/#organization"/, `${relative} needs the canonical author entity`);
    assert.match(body, /class="article-meta"[^>]*>[^<]*(?:<[^>]+>[^<]*<\/[^>]+>[^<]*)*By\s+<a href="\/about">DiffCI<\/a>/, `${relative} needs a visible byline`);
  }
});

test("about and data-handling pages publish verifiable trust routes", () => {
  const about = readFileSync(path.join(site, "about.html"), "utf8");
  const dataHandling = readFileSync(path.join(site, "data-handling.html"), "utf8");
  assert.match(about, /<title>About DiffCI/);
  assert.match(about, /github\.com\/adityankale190895/);
  assert.match(about, /mailto:aditya@diffci\.com/);
  assert.match(about, /mailto:security@diffci\.com/);
  assert.match(dataHandling, /mailto:security@diffci\.com/);
  assert.doesNotMatch(dataHandling, /no mailbox of its own|address for deletion requests and security reports is not yet published/i);
});

test("case-study headings describe the measured search intent", () => {
  const expectations: Array<[string, RegExp]> = [
    ["calcom.html", /<h1>Change-aware test selection on cal\.com<\/h1>/],
    ["deepseek-harness.html", /<h1>Affected-test selection on deepseek-harness<\/h1>/],
    ["diffci-own-ci.html", /<h1>What DiffCI found in its own CI pipeline<\/h1>/],
  ];
  for (const [name, heading] of expectations) {
    assert.match(readFileSync(path.join(site, "case-studies", name), "utf8"), heading);
  }
});

test("agent-specific guides cross-link to every other supported setup", () => {
  const agents = ["claude-code", "codex", "copilot", "cursor", "grok"];
  for (const agent of agents) {
    const body = readFileSync(path.join(site, "docs", `${agent}.html`), "utf8");
    assert.match(body, /<h2>Verify the (?:Claude Code|Codex|Copilot and Actions|Cursor|Grok) setup<\/h2>/);
    for (const sibling of agents.filter((candidate) => candidate !== agent)) {
      assert.match(body, new RegExp(`href="/docs/${sibling}"`), `${agent} should link to ${sibling}`);
    }
  }
});

test("sitemap generation is an explicit build step", () => {
  const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  assert.equal(packageJson.scripts?.["site:sitemap"], "node scripts/generate-site-sitemap.mjs");
  assert.ok(existsSync(path.join(root, "scripts", "generate-site-sitemap.mjs")));
});

test("internal links resolve directly and fragments exist", () => {
  const workerRoutes = new Set(["/mcp", "/mcp/server-card", "/.well-known/ai-catalog.json"]);
  for (const file of htmlFiles()) {
    const body = readFileSync(file, "utf8");
    const sourceCanonical = body.match(/<link\s+rel="canonical"\s+href="([^"]+)"/i)?.[1] ?? "https://diffci.com/";
    for (const match of body.matchAll(/href="([^"]+)"/gi)) {
      const href = match[1]!;
      if (/^(?:mailto:|tel:|data:|javascript:)/i.test(href)) continue;
      const target = new URL(href, sourceCanonical);
      if (target.origin !== "https://diffci.com") continue;
      if (workerRoutes.has(target.pathname)) continue;
      const targetFile = localFileForPath(target.pathname);
      assert.ok(existsSync(targetFile), `${path.relative(site, file)} links to missing ${target.pathname}`);
      if (target.hash && path.extname(target.pathname) !== ".txt") {
        const id = decodeURIComponent(target.hash.slice(1));
        const targetBody = readFileSync(targetFile, "utf8");
        assert.match(targetBody, new RegExp(`\\bid=["']${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`), `${target.pathname}${target.hash} is missing its target`);
      }
    }
  }
});

test("public agent pages describe check execution accurately", () => {
  const files = [path.join(site, "llms.txt"), ...htmlFiles(path.join(site, "docs"))];
  for (const file of files) {
    const body = readFileSync(file, "utf8");
    assert.doesNotMatch(body, /check is observation-only|default command is observation-only|check[^.\n]*runs no tests/i, path.relative(root, file));
  }
});

test("the social image exists at the declared dimensions", () => {
  const png = readFileSync(path.join(site, "assets/diffci-social-card.png"));
  assert.equal(png.subarray(1, 4).toString("ascii"), "PNG");
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
});
