import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SITE_ORIGIN = "https://diffci.com";
const INDEXNOW_KEY = "0d8ca887374f35142a6b1b1cb64ad550";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sitemap = await readFile(path.join(root, "site", "sitemap.xml"), "utf8");
const urlList = [...sitemap.matchAll(/<loc>(https:\/\/diffci\.com\/[^<]*)<\/loc>/g)].map((match) => match[1]);

if (urlList.length === 0) throw new Error("No DiffCI URLs found in site/sitemap.xml");

const response = await fetch("https://api.indexnow.org/IndexNow", {
  method: "POST",
  headers: { "content-type": "application/json; charset=utf-8" },
  body: JSON.stringify({
    host: "diffci.com",
    key: INDEXNOW_KEY,
    keyLocation: `${SITE_ORIGIN}/${INDEXNOW_KEY}.txt`,
    urlList,
  }),
});

if (![200, 202].includes(response.status)) {
  const detail = await response.text();
  throw new Error(`IndexNow rejected the submission (${response.status}): ${detail || response.statusText}`);
}

console.log(`IndexNow accepted ${urlList.length} canonical DiffCI URLs (${response.status}).`);
