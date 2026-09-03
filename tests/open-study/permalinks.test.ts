// Permalink registry guard - see docs/website/permalinks.md.
//
// An external citation is a promise that a URL keeps resolving to what was cited. This test turns
// that promise into a CI failure: every registered path must exist under site/, and a versioned
// (immutable) file's bytes must still hash to the value recorded when it was published. A
// correction is a new -vN file and a new entry, never an edit to an existing one.
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
  {
    url: "/research/2026/diffci-path-rule-article-v1.pdf",
    file: "site/research/2026/diffci-path-rule-article-v1.pdf",
    sha256: "8f763996fa0b5cca8d8e70464cec4c2bb5ae62d6dfb928d32adf582cc82303fa",
  },
  {
    url: "/research/2026/diffci-path-rule-article-v2.pdf",
    file: "site/research/2026/diffci-path-rule-article-v2.pdf",
    sha256: "1734897edfab05ca5598f7f9813da4c5c3ec54ebce23784aff4aac6f4022f56a",
  },
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
    assert.match(d.href, /-v\d+\.pdf$/, `${d.href} must be versioned`);
  }
});

test("the registry document lists every registered permalink", () => {
  const doc = readFileSync(path.join(repoRoot, "docs/website/permalinks.md"), "utf8");
  for (const p of PERMALINKS) {
    assert.ok(doc.includes(p.file), `docs/website/permalinks.md does not mention ${p.file}`);
    if (p.sha256) assert.ok(doc.includes(p.sha256), `docs/website/permalinks.md does not record the hash for ${p.file}`);
  }
});
