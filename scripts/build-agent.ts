/**
 * Builds the proprietary DiffCI observer agent - the only DiffCI artifact that reaches a customer.
 *
 * DECISION (2026-08-27): DiffCI is proprietary and source-private. It is NOT distributed as a
 * third-party `uses:` GitHub Action, because that would require a public repository containing either
 * the source or a committed bundle. Instead the customer's workflow installs an authenticated,
 * version-and-integrity-pinned package and runs it. Everything below exists to make the contents of
 * that package exactly what we intend and nothing else.
 *
 * WHAT THE CUSTOMER GETS, AND WHAT THEY DO NOT. They get one minified JavaScript bundle of DiffCI's own
 * execution-plane code, a manifest, and the licence. They do not get TypeScript source, tests, source
 * maps, comments, research material, or any control-plane module - and `assertPackageContents()` at the
 * end fails the build rather than trusting that to have gone right.
 *
 * BE HONEST ABOUT WHAT THIS BUYS. Minified JavaScript executing on somebody else's runner is not
 * secret. It is compiled distribution under commercial terms: it raises the cost of copying and gives
 * a legal remedy if someone does. A determined customer can still reverse-engineer it. Nothing in this
 * file changes that, and no claim to the contrary should be built on top of it.
 */
import { execFileSync } from "node:child_process";
import { buildSync } from "esbuild";
import { assertShellSafeArgs } from "./shell-safety.js";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const repoRoot = resolve(dirname(import.meta.filename), "..");
const outDir = join(repoRoot, "dist-agent");

/** The published package's identity. `version` is what onboarding pins, exactly - never a range. */
export const AGENT_PACKAGE_NAME = "@diffci/observer";
export const AGENT_ENTRY = "src/client/cli.ts";

/**
 * Left external rather than bundled. `typescript` is the graph builder's actual compiler and cannot be
 * dropped; it also uses dynamic `require`, which an ESM bundle cannot express (this was tried, and the
 * bundle threw at runtime). Keeping both as ordinary dependencies means npm installs them from the
 * registry with the integrity hashes in the consumer's lockfile - and means DiffCI never redistributes
 * third-party code, so no third-party licence notice obligation is created by this build.
 */
const EXTERNAL_DEPENDENCIES = { typescript: "5.8.3", yaml: "2.9.0" } as const;

/** Everything that may appear in the published tarball. Anything else is a build failure. */
const PERMITTED_FILES = ["package.json", "index.mjs", "LICENSE", "README.md"];

function readVersion(): string {
  const explicit = process.argv.find((arg) => arg.startsWith("--version="));
  if (explicit) return explicit.slice("--version=".length);
  return (JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string }).version;
}

function bundle(): void {
  // esbuild's Node API, not its CLI. The CLI has to be reached through `npx.cmd`, which on Windows
  // needs shell:true, which concatenates arguments into a command string - and this repository's own
  // path contains spaces, so `--outfile=C:\...\Swati Kale\...` split into two arguments and the build
  // failed. The API takes real values and never constructs a command line, so the whole class of
  // quoting bug is absent rather than worked around.
  //
  // minify strips comments as a side effect, which matters here: the comments in the execution plane
  // reference internal findings and must not travel to a customer. assertNoSourceLeakage() checks the
  // result rather than trusting that to have happened.
  const result = buildSync({
    entryPoints: [join(repoRoot, AGENT_ENTRY)],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    minify: true,
    legalComments: "none",
    // No source map, ever. A source map beside a minified bundle republishes the original source in
    // full, which would defeat the entire point of this build.
    sourcemap: false,
    // Required, not cosmetic. npm's `bin` shim on Linux and macOS is a symlink executed directly by
    // the shell, so without a shebang the shell tries to parse minified JavaScript as sh and fails on
    // the first brace. Windows never shows this - it gets a .cmd shim that invokes node explicitly -
    // so the bug is invisible on the development machine and fatal on every Linux runner, which is
    // where this actually runs. Found by installing the packed tarball into a clean project.
    banner: { js: "#!/usr/bin/env node" },
    external: Object.keys(EXTERNAL_DEPENDENCIES),
    outfile: join(outDir, "index.mjs"),
    absWorkingDir: repoRoot,
    logLevel: "warning",
  });
  if (result.errors.length > 0) throw new Error(`esbuild reported ${result.errors.length} error(s)`);
}

function writeManifest(version: string): void {
  const manifest = {
    name: AGENT_PACKAGE_NAME,
    version,
    description: "DiffCI observer - change-aware CI analysis that runs inside your own CI. Runs nothing, changes nothing, skips nothing.",
    // Proprietary: npm's own convention for a licence that is not an SPDX open-source identifier.
    license: "SEE LICENSE IN LICENSE",
    type: "module",
    bin: { diffci: "index.mjs" },
    // An allowlist, not an ignore list. A new file in dist-agent/ is excluded by default rather than
    // shipped by default, which is the correct direction for a proprietary artifact.
    files: PERMITTED_FILES,
    engines: { node: ">=20.11.0" },
    dependencies: EXTERNAL_DEPENDENCIES,
    // Deliberately no `repository`, `homepage` or `bugs` pointing at a source host: there is no public
    // source repository, and a dead link implying one would be worse than none.
    private: false,
    publishConfig: { access: "restricted" },
  };
  writeFileSync(join(outDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Fails the build if anything that must not ship has ended up in the staging directory. */
function assertPackageContents(): void {
  const present = readdirSync(outDir).sort();
  const unexpected = present.filter((file) => !PERMITTED_FILES.includes(file));
  if (unexpected.length > 0) {
    throw new Error(`dist-agent contains files that must not be published: ${unexpected.join(", ")}`);
  }
  const missing = ["package.json", "index.mjs", "LICENSE"].filter((file) => !present.includes(file));
  if (missing.length > 0) throw new Error(`dist-agent is missing required files: ${missing.join(", ")}`);
}

/**
 * Reads the built bundle and refuses to ship it if it carries anything from DiffCI's private side.
 *
 * This is not belt-and-braces. Minification removes comments as a side effect of its real job, and a
 * future flag change, a `--sourcemap`, or a string constant that happens to contain a private path
 * would all quietly reintroduce exactly what this build exists to keep out.
 */
function assertNoSourceLeakage(): void {
  const bundleText = readFileSync(join(outDir, "index.mjs"), "utf8");
  const forbidden: Array<{ pattern: RegExp; why: string }> = [
    { pattern: /dentalpresence/i, why: "a private project name" },
    { pattern: /deepseek-harness/i, why: "an internal benchmark identity" },
    { pattern: /docs\/research/i, why: "a path into the private research corpus" },
    { pattern: /src\/(research|shadow|billing|product|ingest|install|usage|ledger|auth|preflight|analysis-fanout|execution-queue)\//i, why: "a control-plane module path" },
    { pattern: /sourceMappingURL/i, why: "a source map, which would republish the original source" },
    { pattern: /workers\.dev|damp-waterfall/i, why: "an internal infrastructure hostname" },
    { pattern: /Stage \d[A-Z]?\b|Phase 0\d\b/, why: "internal programme vocabulary" },
  ];

  const found = forbidden.filter(({ pattern }) => pattern.test(bundleText)).map(({ pattern, why }) => `${pattern} (${why})`);
  if (found.length > 0) throw new Error(`the built agent bundle contains material that must not be distributed:\n  ${found.join("\n  ")}`);
}

function copyLicence(): void {
  const licencePath = join(repoRoot, "ops", "agent", "LICENSE");
  if (!existsSync(licencePath)) {
    throw new Error(`no licence at ${relative(repoRoot, licencePath)} - a proprietary artifact must not ship without its terms`);
  }
  cpSync(licencePath, join(outDir, "LICENSE"));
  const readmePath = join(repoRoot, "ops", "agent", "README.md");
  if (existsSync(readmePath)) cpSync(readmePath, join(outDir, "README.md"));
}

/**
 * The integrity hash onboarding pins, computed the way npm computes it (sha512 of the tarball, base64).
 * Produced by `npm pack --json`, not by hashing anything here: a value we computed ourselves would not
 * necessarily equal the one npm verifies against, and a pin that does not match what the client checks
 * is worse than no pin at all.
 */
function packAndReport(version: string): void {
  // No path arguments. `npm pack` writes into its own cwd by default, so nothing containing a space
  // is ever concatenated into the command line that shell:true builds on Windows - the same bug that
  // broke the esbuild call above, avoided here by not passing --pack-destination at all.
  const packArgs = ["pack", "--json"];
  assertShellSafeArgs(packArgs, "build-agent: npm pack");
  const output = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", packArgs, {
    cwd: outDir,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const [packed] = JSON.parse(output) as Array<{ filename: string; integrity: string; shasum: string; size: number; unpackedSize: number; files: Array<{ path: string; size: number }> }>;
  if (!packed) throw new Error("npm pack produced no result");

  console.log("\nDiffCI observer agent");
  console.log(`  package    ${AGENT_PACKAGE_NAME}@${version}`);
  console.log(`  tarball    ${packed.filename}`);
  console.log(`  size       ${packed.size} bytes packed, ${packed.unpackedSize} unpacked`);
  console.log(`  integrity  ${packed.integrity}`);
  console.log("\n  contents:");
  for (const file of packed.files) console.log(`    ${file.path.padEnd(14)} ${file.size}`);
  console.log("\n  Pin BOTH the exact version and the integrity hash in generated onboarding.");
  console.log("  A semver range is not a pin: it resolves to whatever is newest at install time.\n");
}

function run(): void {
  const version = readVersion();
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  bundle();
  writeManifest(version);
  copyLicence();
  assertPackageContents();
  assertNoSourceLeakage();
  packAndReport(version);
}

if (process.argv[1] && process.argv[1].endsWith("build-agent.ts")) run();

export { PERMITTED_FILES, EXTERNAL_DEPENDENCIES, outDir };
