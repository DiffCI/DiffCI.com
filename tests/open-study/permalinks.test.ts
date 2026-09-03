// Permalink registry guard - see docs/website/permalinks.md.
//
// An external citation is a promise that a URL keeps resolving to what was cited. This test turns
// that promise into a CI failure: every registered path must exist under site/, and a versioned
// (immutable) file's bytes, if any entry carries a sha256, must still hash to the value recorded
// when it was published. Unpinned entries may be replaced in place but are never moved.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { diffciOpenEvidenceStudy2026 as study } from "../../src/open-study/diffci-open-evidence-2026.js";
import { repoRoot } from "../../scripts/render-open-study.js";

type Permalink = { readonly url: string; readonly file: string; readonly sha256?: string };

export const PERMALINKS: readonly Permalink[] = [
  { url: "/research/diffci-open-evidence-2026", file: "site/research/diffci-open-evidence-2026.html" },
  { url: "/research/2026/diffci-open-evidence-2026.csv", file: "site/research/2026/diffci-open-evidence-2026.csv" },
  { url: "/research/2026/diffci-open-evidence-2026.pdf", file: "site/research/2026/diffci-open-evidence-2026.pdf" },
  { url: "/research/2026/LICENSE.txt", file: "site/research/2026/LICENSE.txt" },
  // Founder decision 2026-09-03: the article is published at one plain URL and replaced in place
  // when revised (no -vN suffix, no hash pin). The URL itself is still a permalink: never moved.
  { url: "/research/2026/diffci-path-rule-article.pdf", file: "site/research/2026/diffci-path-rule-article.pdf" },
];

test("every registered permalink resolves to a file under site/", () => {
  for (const p of PERMALINKS) {
    assert.ok(existsSync(path.join(repoRoot, p.file)), `${p.url} -> ${p.file} is missing; permalinks are never moved`);
  }
});

test("versioned permalinks are byte-for-byte what was published", () => {
  for (const p of PERMALINKS) {
    if (!p.sha256) continue;
    assert.match(p.file, /-v\d+\.[a-z]+$/, `${p.file} is hash-pinned but not versioned`);
    const actual = createHash("sha256").update(readFileSync(path.join(repoRoot, p.file))).digest("hex");
    assert.equal(actual, p.sha256, `${p.url} changed; publish a new -vN file instead of editing this one`);
  }
});

test("every companion document the study links to is a registered permalink", () => {
  const registered = new Set(PERMALINKS.map((p) => p.url));
  for (const d of study.companionDocuments) {
    assert.ok(registered.has(d.href), `${d.href} is linked from the study but not in the permalink registry`);
  }
});

test("the registry document lists every registered permalink", () => {
  const doc = readFileSync(path.join(repoRoot, "docs/website/permalinks.md"), "utf8");
  for (const p of PERMALINKS) {
    assert.ok(doc.includes(p.file), `docs/website/permalinks.md does not mention ${p.file}`);
    if (p.sha256) assert.ok(doc.includes(p.sha256), `docs/website/permalinks.md does not record the hash for ${p.file}`);
  }
});
