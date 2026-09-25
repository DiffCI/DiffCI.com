import { execFileSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const siteRoot = path.join(root, "site");
const excluded = new Set(["404.html", "welcome.html"]);

async function htmlFiles(directory = siteRoot) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return htmlFiles(absolute);
    if (!entry.name.endsWith(".html")) return [];
    return [absolute];
  }));
  return nested.flat();
}

function git(args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function modifiedDate(absolute) {
  const relative = path.relative(root, absolute).replaceAll("\\", "/");
  if (git(["status", "--porcelain", "--", relative])) return new Date().toISOString().slice(0, 10);
  return git(["log", "-1", "--format=%as", "--", relative]) || new Date().toISOString().slice(0, 10);
}

const pages = [];
for (const absolute of await htmlFiles()) {
  const relative = path.relative(siteRoot, absolute).replaceAll("\\", "/");
  if (excluded.has(relative)) continue;
  const body = await readFile(absolute, "utf8");
  if (/<meta\s+name="robots"\s+content="[^"]*noindex/i.test(body)) continue;
  const canonical = body.match(/<link\s+rel="canonical"\s+href="(https:\/\/diffci\.com\/[^"]*)"/i)?.[1];
  if (!canonical) throw new Error(`${relative} has no canonical DiffCI URL`);
  pages.push({ canonical, lastmod: modifiedDate(absolute) });
}

pages.sort((a, b) => {
  if (a.canonical === "https://diffci.com/") return -1;
  if (b.canonical === "https://diffci.com/") return 1;
  return a.canonical.localeCompare(b.canonical);
});

const xml = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...pages.map(({ canonical, lastmod }) => `  <url><loc>${canonical}</loc><lastmod>${lastmod}</lastmod></url>`),
  '</urlset>',
  '',
].join("\n");

await writeFile(path.join(siteRoot, "sitemap.xml"), xml, "utf8");
console.log(`Wrote ${pages.length} canonical URLs to site/sitemap.xml.`);
