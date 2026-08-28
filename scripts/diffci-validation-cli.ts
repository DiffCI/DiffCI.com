/**
 * Driver for the canonical Linux validation environment (2026-08-28).
 *
 * Subcommands:
 *   pack      build + upload the DiffCI source tarball and the packaged agent tarball to R2
 *   start     seed a validation run for one allowlisted job
 *   status    print the run record
 *   collect   download the collected run into .dogfood/runs/<runId> so dogfood:freeze can read it
 *
 * Environment:
 *   DIFFCI_VALIDATION_URL      the Worker base URL (or pass --base-url)
 *   VALIDATION_CONTROL_TOKEN   bearer token for the control plane
 *
 * The token is read from the environment and sent in an Authorization header. It is never logged,
 * never written to a file, and never passed as a command-line argument (argv is visible to other
 * processes; environment variables are not, to the same degree).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = resolve(dirname(import.meta.filename), "..");
const BUCKET = "diffci-validation-env";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function token(): string | undefined {
  return process.env.VALIDATION_CONTROL_TOKEN;
}

function baseUrl(args: Record<string, string>): string {
  const url = args["base-url"] ?? process.env.DIFFCI_VALIDATION_URL;
  if (!url) fail("set DIFFCI_VALIDATION_URL or pass --base-url");
  return url.replace(/\/+$/, "");
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Tracked + untracked-but-not-ignored files. Mirrors the analysis-fanout packer. */
function workingTreeFiles(): string[] {
  const tracked = spawnSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" });
  const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: REPO_ROOT, encoding: "utf8" });
  if (tracked.status !== 0 || untracked.status !== 0) fail("git ls-files failed");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of [...(tracked.stdout ?? "").split(/\r?\n/), ...(untracked.stdout ?? "").split(/\r?\n/)]) {
    const f = line.trim().replace(/\\/g, "/");
    if (!f || f.startsWith("node_modules/") || f.startsWith(".git/") || seen.has(f)) continue;
    seen.add(f);
    out.push(f);
  }
  return out;
}

function buildTarball(outPath: string, files: string[]): void {
  const listPath = `${outPath}.files.txt`;
  writeFileSync(listPath, files.join("\n"), "utf8");
  // `--force-local`: GNU tar reads an absolute `C:\...` path as a remote host:file spec.
  const r = spawnSync("tar", ["--force-local", "-czf", outPath, "-T", listPath], { cwd: REPO_ROOT, encoding: "utf8" });
  if (r.status !== 0) fail(`tar failed: ${r.stderr ?? r.stdout}`);
}

function r2Put(key: string, localPath: string): void {
  const wranglerBin = join(REPO_ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
  const r = spawnSync(process.execPath, [wranglerBin, "r2", "object", "put", `${BUCKET}/${key}`, "--file", localPath, "--remote"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (r.status !== 0) fail(`wrangler r2 object put failed (exit ${r.status}): ${r.stderr ?? r.stdout}`);
}

async function api(args: Record<string, string>, path: string, init?: RequestInit): Promise<Response> {
  if (!token()) fail("set VALIDATION_CONTROL_TOKEN");
  return fetch(`${baseUrl(args)}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), authorization: `Bearer ${token()!}` },
  });
}

/**
 * Uploads the two things the container needs and cannot obtain for itself: DiffCI's own source, and the
 * packaged agent.
 *
 * The agent tarball is uploaded SEPARATELY rather than inside the source tarball because `dist-agent/`
 * is gitignored, so `git ls-files` never sees it. Shipping the exact bytes (rather than rebuilding the
 * agent in the container) is what makes "same agent digest" literally true for a reproduction, instead
 * of "same agent version, rebuilt elsewhere".
 */
function cmdPack(): void {
  const distAgent = join(REPO_ROOT, "dist-agent");
  const tarballs = existsSync(distAgent) ? readdirSync(distAgent).filter((f) => f.endsWith(".tgz")) : [];
  if (tarballs.length !== 1) fail(`expected exactly one .tgz in dist-agent, found ${tarballs.length}. Run: npm run build:agent`);
  const agentLocal = join(distAgent, tarballs[0]!);
  const agentSha = sha256File(agentLocal);
  const agentIntegrity = `sha512-${createHash("sha512").update(readFileSync(agentLocal)).digest("base64")}`;

  const files = workingTreeFiles();
  mkdirSync(join(REPO_ROOT, "dist"), { recursive: true });
  const sourceLocal = join(REPO_ROOT, "dist", "validation-source.tgz");
  buildTarball(sourceLocal, files);
  const sourceSha = sha256File(sourceLocal);

  // Content-addressed keys: two packs of the same tree reuse one object, and a changed tree can never
  // overwrite the bytes an earlier run's evidence points at.
  const sourceKey = `sources/diffci-${sourceSha.slice(0, 16)}.tgz`;
  const agentKey = `agents/observer-${agentSha.slice(0, 16)}.tgz`;

  r2Put(sourceKey, sourceLocal);
  r2Put(agentKey, agentLocal);

  console.log(
    JSON.stringify(
      { ok: true, sourceKey, sourceSha256: sourceSha, sourceFiles: files.length, agentKey, agentSha256: agentSha, agentIntegrity },
      null,
      2,
    ),
  );
}

async function cmdStart(args: Record<string, string>): Promise<void> {
  const runId = args["run-id"];
  const jobId = args.job;
  if (!runId || !/^[A-Za-z0-9._-]{1,128}$/.test(runId)) fail("start requires --run-id <id>");
  if (!jobId) fail("start requires --job <jobId>");
  const sourceTarballKey = args["source-key"] ?? fail("start requires --source-key (from pack)");
  const sourceTarballSha256 = args["source-sha256"] ?? fail("start requires --source-sha256 (from pack)");
  const agentTarballKey = args["agent-key"] ?? fail("start requires --agent-key (from pack)");

  const res = await api(args, "/v1/start", {
    method: "POST",
    body: JSON.stringify({ runId, jobId, sourceTarballKey, sourceTarballSha256, agentTarballKey }),
  });
  console.log(await res.text());
}

async function cmdStatus(args: Record<string, string>): Promise<void> {
  const runId = args["run-id"] ?? fail("status requires --run-id");
  const res = await api(args, `/v1/state?runId=${encodeURIComponent(runId)}`);
  const text = await res.text();
  try {
    const record = JSON.parse(text) as Record<string, unknown>;
    const timings = (record.timings ?? {}) as Record<string, number>;
    console.log(`step        ${String(record.step)}`);
    if (record.errorClass) console.log(`error       ${String(record.errorClass)}: ${String(record.error ?? "")}`);
    if (record.environment) console.log(`environment ${JSON.stringify(record.environment)}`);
    if (record.observedRows !== undefined && record.observedRows !== null) console.log(`observed    ${String(record.observedRows)} rows`);
    if (Object.keys(timings).length > 0) console.log(`timings     ${JSON.stringify(timings)}`);
    if (record.heartbeatAt) console.log(`heartbeat   ${new Date(Number(record.heartbeatAt)).toISOString()}`);
  } catch {
    console.log(text);
  }
}

/**
 * Pull the collected run down into the same shape a local run produces, so `dogfood:freeze` reads it
 * without knowing it came from a container.
 *
 * `manifest.json` is written EXACTLY as the container produced it - including its container-side
 * `corpusPath`. Rewriting that path to a local one would make the manifest describe a run that never
 * happened, which is the class of quiet mutation the immutable-run-directory work exists to prevent.
 */
async function cmdCollect(args: Record<string, string>): Promise<void> {
  const runId = args["run-id"] ?? fail("collect requires --run-id");
  const files = ["manifest.json", "results.jsonl", "COMPLETE", "corpus.jsonl", "environment.json", "observe.log", "mutate.log"];

  const fetched: Record<string, string> = {};
  for (const file of files) {
    const res = await api(args, `/v1/result?runId=${encodeURIComponent(runId)}&file=${encodeURIComponent(file)}`);
    if (res.status === 404) continue;
    if (!res.ok) fail(`fetching ${file} failed: ${res.status} ${await res.text()}`);
    fetched[file] = await res.text();
  }
  for (const required of ["manifest.json", "results.jsonl", "COMPLETE"]) {
    if (fetched[required] === undefined) fail(`run ${runId} is missing ${required} - it did not complete`);
  }

  const manifest = JSON.parse(fetched["manifest.json"]!) as { runId?: string };
  const localRunId = manifest.runId ?? runId;
  const outDir = resolve(args.out ?? join(REPO_ROOT, ".dogfood", "runs", localRunId));
  mkdirSync(outDir, { recursive: true });
  for (const [name, content] of Object.entries(fetched)) writeFileSync(join(outDir, name), content);

  console.log(`\nCollected ${Object.keys(fetched).length} file(s) into ${outDir}\n`);
  const env = fetched["environment.json"] ? (JSON.parse(fetched["environment.json"]!) as Record<string, unknown>) : undefined;
  if (env?.environment) console.log(`  environment: ${JSON.stringify(env.environment)}`);
  console.log(`\nFreeze it with:\n  npm run dogfood:freeze -- --run ${outDir}\n`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const args: Record<string, string> = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a?.startsWith("--")) {
      const next = argv[i + 1];
      args[a.slice(2)] = next && !next.startsWith("--") ? (i++, next) : "true";
    }
  }

  switch (command) {
    case "pack":
      return cmdPack();
    case "start":
      return cmdStart(args);
    case "status":
      return cmdStatus(args);
    case "collect":
      return cmdCollect(args);
    default:
      fail("usage: pack | start | status | collect (see the script header)");
  }
}

void main();
