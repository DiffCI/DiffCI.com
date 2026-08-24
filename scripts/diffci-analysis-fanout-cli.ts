/**
 * Local CLI driver for the DiffCI Cloudflare analysis fan-out (2026-08-23).
 *
 * Subcommands: pack, start, status, collect (see the original blind-baseline brief).
 * Every HTTP call uses an AbortController timeout; secrets come from ANALYSIS_CONTROL_TOKEN (env),
 * base URL from DIFFCI_ANALYSIS_FANOUT_URL or --base-url.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { collectRunRecordFileName, resolveCollectWrite } from "../src/analysis-fanout/collect-names.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BLIND_DIR = join(REPO_ROOT, "docs", "research", "blind-baseline-2026-08-23");
const FROZEN_MANIFEST_LOCAL = join(BLIND_DIR, "2026-08-23-diffci-frozen-build-manifest.json");
const FROZEN_MANIFEST_KEY = "manifests/2026-08-23-diffci-frozen-build-manifest.json";

/** Short alias -> resolved GitHub owner/name (the manifest's resolvedRepository). */
const REPO_ALIASES: Record<string, string> = {
  turborepo: "vercel/turborepo",
  biome: "biomejs/biome",
  calcom: "calcom/cal.diy",
  nx: "nrwl/nx",
  deepseek: "deepseek-ai/deepseek-harness",
};
const SHORT_BY_NAME = new Map<string, string>(Object.entries(REPO_ALIASES).map(([s, n]) => [n, s]));

function selectionManifestLocal(short: string): string {
  return join(BLIND_DIR, `2026-08-23-${short}-blind-baseline-selection-manifest.json`);
}
function selectionManifestKey(short: string): string {
  return `manifests/2026-08-23-${short}-blind-baseline-selection-manifest.json`;
}

function parseArgs(argv: string[]): { command: string; args: Record<string, string> } {
  const command = argv[0] ?? "";
  const args: Record<string, string> = {};
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith("--")) args[arg.slice(2)] = argv[++i] ?? "";
  }
  return { command, args };
}

function baseUrl(args: Record<string, string>): string {
  return args["base-url"] ?? process.env.DIFFCI_ANALYSIS_FANOUT_URL ?? "";
}
function token(): string {
  return process.env.ANALYSIS_CONTROL_TOKEN ?? "";
}
function fail(msg: string): never {
  console.error(JSON.stringify({ ok: false, error: msg }));
  process.exit(1);
}

async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = 60_000): Promise<{ status: number; body: unknown }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...init, signal: ctrl.signal, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });
    const text = await resp.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: resp.status, body };
  } finally {
    clearTimeout(t);
  }
}

async function fetchText(url: string, init: RequestInit = {}, timeoutMs = 60_000): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...init, signal: ctrl.signal });
    return await resp.text();
  } finally {
    clearTimeout(t);
  }
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${token()}` };
}

function sha256File(path: string): { hex: string; bytes: number } {
  const buf = readFileSync(path);
  return { hex: createHash("sha256").update(buf).digest("hex"), bytes: buf.length };
}

/** Upload a local file to R2 via wrangler's own JS entry point (node_modules/wrangler/bin/wrangler.js),
 * invoked with `process.execPath` - NOT `npx`/`npx.cmd`. Harness-only fixes (2026-08-24), neither
 * touching the checksummed engineFiles set: (1) `--remote` is REQUIRED - without it `wrangler r2 object
 * put` silently writes to wrangler's local dev-mode R2 simulator, not the real bucket the deployed
 * Worker reads (confirmed: an object written without --remote was absent from the remote bucket
 * immediately after). Every prior "pack" on this machine would have produced tarball/manifest keys the
 * live Worker could never see. (2) `spawnSync("npx", ...)` fails to spawn at all on this Windows box, and
 * `spawnSync("npx.cmd", ...)` fails with EINVAL (Node cannot exec a .cmd batch file directly without a
 * shell), while `shell: true` breaks argv quoting for this repo's own path (it contains a space: "Swati
 * Kale") and truncates --file's argument. Running wrangler's .js entry directly via `process.execPath`
 * sidesteps the .cmd shim and the shell entirely - the exact pattern scripts/diffci-blind-baseline.ts
 * already uses for tsx's cli.mjs. */
function r2Put(bucket: string, key: string, localPath: string): void {
  const wranglerBin = join(REPO_ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
  const r = spawnSync(process.execPath, [wranglerBin, "r2", "object", "put", `${bucket}/${key}`, "--file", localPath, "--remote"], { cwd: REPO_ROOT, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`wrangler r2 object put failed (exit ${r.status}): ${r.stderr ?? r.stdout}`);
}

function shouldExcludeTarball(p: string): boolean {
  const n = p.replace(/\\/g, "/");
  if (n.startsWith("node_modules/") || n.startsWith(".git/")) return true;
  if (/^docs\/research\/.*\.jsonl$/.test(n)) return true;
  return false;
}

/** Tracked + untracked files of the current working tree, minus the excluded paths. */
function workingTreeFiles(): string[] {
  const tracked = spawnSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" });
  const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: REPO_ROOT, encoding: "utf8" });
  if (tracked.status !== 0 || untracked.status !== 0) throw new Error("git ls-files failed");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of [...(tracked.stdout ?? "").split(/\r?\n/), ...(untracked.stdout ?? "").split(/\r?\n/)]) {
    const f = line.trim();
    if (!f || shouldExcludeTarball(f) || seen.has(f)) continue;
    seen.add(f);
    out.push(f);
  }
  return out;
}

/** Build a .tgz of the given relative file list using the system `tar` (GNU tar on this Windows box,
 * via Git Bash). Harness-only fix (2026-08-23): GNU tar treats an absolute `C:\...\out.tgz` path as a
 * remote "host:file" spec (the classic tar-over-rsh colon ambiguity) and fails with "Cannot connect to
 * C: resolve failed". `--force-local` disables that heuristic; this file is outside the checksummed
 * engineFiles set (verified) and this change cannot affect analysis/classification/graph/test-discovery. */
function buildTarball(outPath: string, files: string[]): void {
  const listPath = `${outPath}.files.txt`;
  writeFileSync(listPath, files.map((f) => f.replace(/\\/g, "/")).join("\n"), "utf8");
  const r = spawnSync("tar", ["--force-local", "-czf", outPath, "-T", listPath], { cwd: REPO_ROOT, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`tar failed (exit ${r.status}): ${r.stderr ?? r.stdout}`);
}

/** Run the frozen-engine verifier locally against the given manifest; throw if it drifts.
 * `--frozen-manifest <path>` (cmdPack) lets a caller verify against an ADAPTED build manifest instead
 * of the original 2026-08-23 one, WITHOUT touching that original file - required once the engine is
 * intentionally changed post-blind-baseline (any such run must be labeled an adapted replay, never a
 * blind baseline). Defaults to the original path for full backward compatibility. */
function verifyFrozenEngine(manifestPath: string = FROZEN_MANIFEST_LOCAL): number {
  const r = spawnSync("node", ["docs/research/blind-baseline-2026-08-23/verify-frozen-engine.cjs", "--manifest", manifestPath], { cwd: REPO_ROOT, encoding: "utf8" });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (!output.includes("MATCH")) {
    throw new Error(`verify-frozen-engine.cjs did not report MATCH against ${manifestPath} (exit ${r.status}). Refusing to pack.\n${output.slice(-2000)}`);
  }
  return r.status ?? 1;
}

async function cmdPack(args: Record<string, string>): Promise<void> {
  const runId = args["run-id"] ?? "";
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(runId)) fail("pack requires --run-id <id> matching ^[a-zA-Z0-9_-]{1,128}$");
  const bucket = process.env.ANALYSIS_BUCKET_NAME ?? "diffci-analysis-fanout";
  const frozenManifestLocal = args["frozen-manifest"] ? resolve(args["frozen-manifest"]) : FROZEN_MANIFEST_LOCAL;
  const frozenManifestKey = args["frozen-manifest-key"] ?? FROZEN_MANIFEST_KEY;

  // 1. Refuse to pack if the (possibly adapted) frozen engine has drifted locally.
  const verifyExit = verifyFrozenEngine(frozenManifestLocal);
  const frozen = JSON.parse(readFileSync(frozenManifestLocal, "utf8")) as { engineChecksum: string; gitHead: string };
  const gitHead = frozen.gitHead;

  // 2. Build the source tarball of the current working tree, keyed by the TARBALL'S OWN content hash
  // (2026-08-24 fix), not gitHead: an adapted-engine tarball has a different working tree but the SAME
  // gitHead (uncommitted edits), so a gitHead-keyed name would silently overwrite the original blind-
  // baseline tarball in R2 under a key existing pack records still point to. Content-addressing makes
  // that collision structurally impossible regardless of which manifest is used.
  const tarballLocal = join(REPO_ROOT, "dist", `diffci-${gitHead.slice(0, 12)}-${runId}.tgz`);
  const files = workingTreeFiles();
  buildTarball(tarballLocal, files);
  const { hex: tarballSha256, bytes: tarballBytes } = sha256File(tarballLocal);
  const tarballKey = `tarballs/diffci-${tarballSha256.slice(0, 16)}.tgz`;

  // 3. Upload tarball + pack record + frozen manifest + four selection manifests to R2.
  r2Put(bucket, tarballKey, tarballLocal);
  const packRecord = {
    tarballKey,
    tarballSha256,
    tarballBytes,
    engineChecksum: frozen.engineChecksum,
    frozenManifestKey,
    gitHead,
    verifyFrozenEngineExit: verifyExit,
  };
  const packLocal = join(REPO_ROOT, "dist", `${runId}-pack-record.json`);
  writeFileSync(packLocal, JSON.stringify(packRecord, null, 2), "utf8");
  r2Put(bucket, `manifests/${runId}/pack-record.json`, packLocal);
  r2Put(bucket, frozenManifestKey, frozenManifestLocal);
  for (const short of Object.keys(REPO_ALIASES)) {
    const local = selectionManifestLocal(short);
    if (existsSync(local)) r2Put(bucket, selectionManifestKey(short), local);
  }

  console.log(JSON.stringify({ ok: true, runId, tarballKey, tarballSha256, tarballBytes, engineChecksum: frozen.engineChecksum, frozenManifestKey, files: files.length }, null, 2));
}

async function cmdStart(args: Record<string, string>): Promise<void> {
  const runId = args["run-id"] ?? "";
  const reposArg = args.repos ?? "";
  const shards = Number.parseInt(args.shards ?? "8", 10);
  const maxConcurrentShards = Number.parseInt(args["max-concurrent"] ?? "16", 10);
  const url = baseUrl(args);
  if (!url) fail("start requires DIFFCI_ANALYSIS_FANOUT_URL or --base-url");
  if (!token()) fail("start requires ANALYSIS_CONTROL_TOKEN env var");
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(runId)) fail("start requires --run-id <id>");
  if (!reposArg) fail("start requires --repos turborepo,biome,calcom,nx");
  if (!Number.isInteger(shards) || shards < 1) fail("--shards must be a positive integer");

  const bucket = process.env.ANALYSIS_BUCKET_NAME ?? "diffci-analysis-fanout";
  const repositories: { name: string; manifestKey: string }[] = [];
  for (const raw of reposArg.split(",")) {
    const alias = raw.trim();
    if (!alias) continue;
    const name = REPO_ALIASES[alias] ?? (alias.includes("/") ? alias : undefined);
    if (!name) fail(`unknown repo alias: ${alias} (known: ${Object.keys(REPO_ALIASES).join(", ")})`);
    const short = SHORT_BY_NAME.get(name) ?? alias.replace("/", "-");
    const local = selectionManifestLocal(short);
    if (!existsSync(local)) fail(`selection manifest not found locally: ${local}`);
    r2Put(bucket, selectionManifestKey(short), local);
    repositories.push({ name, manifestKey: selectionManifestKey(short) });
  }

  const { status, body } = await fetchJson(`${url}/v1/run`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ runId, repositories, shardsPerRepository: shards, maxConcurrentShards }),
  });
  console.log(JSON.stringify({ status, body }, null, 2));
  if (status !== 200) process.exit(1);
}

async function cmdStatus(args: Record<string, string>): Promise<void> {
  const runId = args["run-id"] ?? "";
  const url = baseUrl(args);
  if (!url) fail("status requires DIFFCI_ANALYSIS_FANOUT_URL or --base-url");
  if (!token()) fail("status requires ANALYSIS_CONTROL_TOKEN env var");
  const { status, body } = await fetchJson(`${url}/v1/run/${runId}`, { headers: authHeaders() });
  if (status !== 200) fail(`GET /v1/run/${runId} -> ${status}: ${JSON.stringify(body)}`);
  console.log(JSON.stringify(body, null, 2));
}

async function cmdCollect(args: Record<string, string>): Promise<void> {
  const runId = args["run-id"] ?? "";
  const outDir = resolve(args.out ?? BLIND_DIR);
  const retryRunId = args["retry-run-id"] ?? "";
  const retryReason = args["retry-reason"] ?? "";
  const url = baseUrl(args);
  if (!url) fail("collect requires DIFFCI_ANALYSIS_FANOUT_URL or --base-url");
  if (!token()) fail("collect requires ANALYSIS_CONTROL_TOKEN env var");

  const { status, body } = await fetchJson(`${url}/v1/run/${runId}`, { headers: authHeaders() });
  if (status !== 200) fail(`GET /v1/run/${runId} -> ${status}: ${JSON.stringify(body)}`);
  const state = body as { repositories?: { name: string }[] };

  const written: string[] = [];
  for (const repo of state.repositories ?? []) {
    const short = SHORT_BY_NAME.get(repo.name) ?? repo.name.replace("/", "-");
    const rows = await fetchText(`${url}/v1/run/${runId}/rows?repository=${encodeURIComponent(repo.name)}`, { headers: authHeaders() }, 120_000);
    const decision = resolveCollectWrite(outDir, short, retryRunId, retryReason, existsSync);
    if (decision.exists) {
      fail(`refusing to overwrite existing ${decision.path} (use --retry-run-id/--retry-reason to write a retry file)`);
    }
    writeFileSync(decision.path, rows, "utf8");
    written.push(decision.path);
  }

  const runRecordPath = join(outDir, collectRunRecordFileName(runId));
  if (existsSync(runRecordPath)) fail(`refusing to overwrite existing ${runRecordPath}`);
  writeFileSync(runRecordPath, JSON.stringify(body, null, 2), "utf8");
  written.push(runRecordPath);

  console.log(JSON.stringify({ ok: true, runId, written }, null, 2));
}

async function main(): Promise<void> {
  const { command, args } = parseArgs(process.argv.slice(2));
  switch (command) {
    case "pack":
      return cmdPack(args);
    case "start":
      return cmdStart(args);
    case "status":
      return cmdStatus(args);
    case "collect":
      return cmdCollect(args);
    default:
      fail("usage: pack | start | status | collect (see script header)");
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});