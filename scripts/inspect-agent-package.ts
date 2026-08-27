/**
 * Inspects the packed agent tarball - the actual bytes a customer receives.
 *
 * WHY THIS IS SEPARATE FROM THE BUILD'S OWN CHECKS. `scripts/build-agent.ts` asserts against
 * `dist-agent/`, the directory it just wrote. That answers "did I stage the right things", which is a
 * different question from "what is in the tarball". Between the two sits `npm pack`, which applies
 * `files`, `.npmignore`, `.gitignore` inheritance, and a set of always-included and always-excluded
 * names of its own. Those four files ARE the product; they deserve to be examined as shipped rather
 * than as intended.
 *
 * Run: npm run inspect:agent [path/to/tarball.tgz]
 */
import { gunzipSync } from "node:zlib";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const repoRoot = resolve(dirname(import.meta.filename), "..");

/** Exactly what may be inside the tarball, and nothing else. */
const EXPECTED_ENTRIES = ["package/LICENSE", "package/README.md", "package/index.mjs", "package/package.json"];

/**
 * Material that must not reach a customer. Each entry says why, so a future hit is actionable rather
 * than a mystery. These run over EVERY shipped file, not only the bundle: the README and the licence
 * are distributed too, and a stray internal hostname in prose ships just as far as one in code.
 */
const FORBIDDEN: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /dentalpresence/i, why: "a private project name" },
  { pattern: /deepseek[- ]?harness/i, why: "an internal benchmark identity" },
  { pattern: /docs\/research/i, why: "a path into the private research corpus" },
  { pattern: /src\/(research|shadow|billing|product|ingest|install|usage|ledger|auth|preflight|analysis-fanout|execution-queue)\//i, why: "a control-plane module path" },
  { pattern: /sourceMappingURL/i, why: "a source map, which would republish the original source" },
  { pattern: /workers\.dev|damp-waterfall/i, why: "an internal infrastructure hostname" },
  { pattern: /\bStage \d[A-Z]?\b|\bPhase 0\d\b/, why: "internal programme vocabulary" },
  { pattern: /adityankale|571ba9bf/i, why: "an internal account or owner identifier" },
  { pattern: /[A-Z]:\\Users\\|\/home\/[a-z]+\/|OneDrive/i, why: "a developer machine path" },
  { pattern: /RESEARCH_DISPATCH|CSRF_SECRET|GITHUB_APP_PRIVATE_KEY|LEMONSQUEEZY/i, why: "a control-plane secret name" },
  { pattern: /dci_[A-Za-z0-9]{8,}/, why: "something shaped like a live ingest credential" },
];

function findTarball(): string {
  const explicit = process.argv[2];
  if (explicit) return resolve(explicit);
  const dir = join(repoRoot, "dist-agent");
  const found = readdirSync(dir).filter((f) => f.endsWith(".tgz"));
  if (found.length !== 1) throw new Error(`expected exactly one .tgz in dist-agent, found ${found.length}. Run: npm run build:agent`);
  return join(dir, found[0]!);
}

/**
 * Reads the archive in-process rather than shelling out to `tar`.
 *
 * Two reasons, and the second is the real one. GNU tar - which is what Git Bash provides on Windows -
 * reads `C:\path` as a remote host specification and fails with "Cannot connect to C:". And more
 * importantly, a tool whose entire purpose is "report exactly what is in this file" should not depend
 * on whichever `tar` happens to be first on PATH. The format is simple enough to read directly: 512-byte
 * headers, name at offset 0, size as octal at 124, contents padded to a 512-byte boundary.
 */
function readTarball(tarball: string): Map<string, Buffer> {
  const raw = gunzipSync(readFileSync(tarball));
  const files = new Map<string, Buffer>();

  for (let offset = 0; offset + 512 <= raw.length; ) {
    const header = raw.subarray(offset, offset + 512);
    // Two consecutive zero blocks mark the end of the archive.
    if (header.every((byte) => byte === 0)) break;

    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const sizeField = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = parseInt(sizeField, 8) || 0;
    const typeFlag = String.fromCharCode(header[156]!);

    offset += 512;
    // '0' and '\0' are regular files; directories and metadata entries carry no content worth reading.
    if (typeFlag === "0" || typeFlag === "\0") files.set(name, raw.subarray(offset, offset + size));
    offset += Math.ceil(size / 512) * 512;
  }

  return files;
}

function main(): void {
  const tarball = findTarball();
  const files = readTarball(tarball);
  const problems: string[] = [];

  const entries = [...files.keys()].sort();
  const unexpected = entries.filter((e) => !EXPECTED_ENTRIES.includes(e));
  const missing = EXPECTED_ENTRIES.filter((e) => !entries.includes(e));
  if (unexpected.length > 0) problems.push(`tarball contains unexpected entries: ${unexpected.join(", ")}`);
  if (missing.length > 0) problems.push(`tarball is missing expected entries: ${missing.join(", ")}`);

  console.log(`\nDiffCI agent package inspection`);
  console.log(`  tarball  ${relative(repoRoot, tarball)}`);
  console.log(`  entries  ${entries.length}\n`);

  const read = (name: string): string => (files.get(`package/${name}`) ?? Buffer.alloc(0)).toString("utf8");

  for (const entry of entries) {
    const name = entry.replace(/^package\//, "");
    const buffer = files.get(entry)!;
    const contents = buffer.toString("utf8");

    const hits = FORBIDDEN.filter(({ pattern }) => pattern.test(contents));
    for (const { pattern, why } of hits) problems.push(`${name}: matches ${pattern} - ${why}`);

    console.log(`  ${name.padEnd(14)} ${String(buffer.length).padStart(7)} bytes   ${hits.length === 0 ? "clean" : `${hits.length} PROBLEM(S)`}`);
  }

  // The manifest is the one file whose exact values matter to a consumer's package manager.
  const manifest = JSON.parse(read("package.json")) as Record<string, unknown>;
  console.log(`\n  manifest`);
  for (const key of ["name", "version", "license", "type", "bin", "engines", "dependencies", "publishConfig"]) {
    console.log(`    ${key.padEnd(14)} ${JSON.stringify(manifest[key])}`);
  }
  if (manifest.scripts !== undefined) problems.push("package.json declares scripts - a published package should run nothing on install");
  if (manifest.private === true) problems.push('package.json has "private": true, which blocks publishing entirely');
  if (typeof manifest.license !== "string" || manifest.license.length === 0) problems.push("package.json declares no licence");

  // The shebang is what makes npm's POSIX bin shim executable. Its absence is invisible on Windows.
  if (!read("index.mjs").startsWith("#!/usr/bin/env node")) problems.push("index.mjs has no shebang - npm's bin shim will fail on Linux and macOS");

  // A licence still carrying its drafting markers must not go to a customer.
  const draftMarkers = [/>>>/, /\[LEGAL ENTITY NAME\]/, /\[JURISDICTION\]/, /\[CAP AMOUNT/, /\bDRAFT\b/];
  const draftHits = draftMarkers.filter((marker) => marker.test(read("LICENSE")));
  if (draftHits.length > 0) {
    problems.push(`LICENSE still contains ${draftHits.length} drafting marker(s) - it has not been through legal review and must not be published`);
  }

  // Only genuinely-unfinished placeholders. An install example containing a specimen version is
  // template text doing its job; a package shipped with no way to report a vulnerability is not.
  const readme = read("README.md");
  for (const placeholder of ["<SUPPORT CONTACT", "<SECURITY CONTACT"]) {
    if (readme.includes(placeholder)) problems.push(`README.md still contains the placeholder "${placeholder}" - a customer must have a way to reach you`);
  }

  console.log(`\n  ${problems.length === 0 ? "No problems found." : `${problems.length} problem(s) - NOT READY TO PUBLISH:`}`);
  for (const problem of problems) console.log(`    - ${problem}`);
  console.log();

  process.exit(problems.length > 0 ? 1 : 0);
}

main();
