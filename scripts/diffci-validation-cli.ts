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
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

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
/**
 * Source files newer than the packaged agent, newest first.
 *
 * Only `src/` is consulted: that is what the agent bundle is built from. Scripts, docs and tests do
 * not enter the agent, so treating their mtimes as staleness would refuse valid packs.
 */
function staleSourcesAgainst(agentTarball: string): string[] {
  let agentMtime: number;
  try { agentMtime = statSync(agentTarball).mtimeMs; } catch { return []; }
  const out: Array<{ path: string; mtime: number }> = [];
  const walk = (dir: string): void => {
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full);
      else if (/.(ts|tsx|mts|cts|js|mjs|cjs|json)$/.test(name) && st.mtimeMs > agentMtime) {
        out.push({ path: relative(REPO_ROOT, full), mtime: st.mtimeMs });
      }
    }
  };
  walk(join(REPO_ROOT, "src"));
  return out.sort((a, b) => b.mtime - a.mtime).map((e) => e.path);
}

function cmdPack(): void {
  const distAgent = join(REPO_ROOT, "dist-agent");
  const tarballs = existsSync(distAgent) ? readdirSync(distAgent).filter((f) => f.endsWith(".tgz")) : [];
  if (tarballs.length !== 1) fail(`expected exactly one .tgz in dist-agent, found ${tarballs.length}. Run: npm run build:agent`);
  const agentLocal = join(distAgent, tarballs[0]!);

  // DEFECT 18 (2026-08-31). `pack` uploads whatever tarball is already sitting in dist-agent and never
  // rebuilds it. After the defect-17 analyser change, packing reported the UNCHANGED generation-B
  // digest - so a qualification run would have measured the OLD analyser while every artifact claimed
  // the new one, and the corrected behaviour would have been inherited into results that never had it.
  //
  // It REFUSES rather than silently rebuilding: an operator who believes the wrong analyser is under
  // test needs to be told so, not quietly corrected.
  const stale = staleSourcesAgainst(agentLocal);
  if (stale.length > 0) {
    fail(
      `the packaged agent is OLDER than ${stale.length} source file(s) it is built from, so packing it ` +
        `would upload a stale analyser under a fresh label. Newest: ${stale.slice(0, 3).join(", ")}. ` +
        `Run: npm run build:agent`,
    );
  }

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

  const shards = args.shards ? Number(args.shards) : 1;
  const res = await api(args, "/v1/start", {
    method: "POST",
    body: JSON.stringify({ runId, jobId, sourceTarballKey, sourceTarballSha256, agentTarballKey, shards }),
  });
  console.log(await res.text());
}

interface ShardState {
  shardIndex?: number;
  step?: string;
  errorClass?: string;
  error?: string;
  environment?: Record<string, unknown>;
  observedRows?: number;
  selectableCandidates?: number;
  totalSelectableCandidates?: number;
  resultRows?: number;
  timings?: Record<string, number>;
  heartbeatAt?: number;
}

/** Resolves a run to its shards, whether it was sharded or not. */
async function fetchState(args: Record<string, string>, runId: string): Promise<{ shardCount: number; shards: ShardState[] }> {
  const res = await api(args, `/v1/state?runId=${encodeURIComponent(runId)}`);
  const text = await res.text();
  if (!res.ok) fail(`state for ${runId}: ${res.status} ${text}`);
  const body = JSON.parse(text) as ShardState & { shardCount?: number; shards?: ShardState[] };
  if (Array.isArray(body.shards)) return { shardCount: body.shardCount ?? body.shards.length, shards: body.shards };
  return { shardCount: 1, shards: [body] };
}

async function cmdStatus(args: Record<string, string>): Promise<void> {
  const runId = args["run-id"] ?? fail("status requires --run-id");
  const { shardCount, shards } = await fetchState(args, runId);

  if (shardCount === 1) {
    const r = shards[0]!;
    console.log(`step        ${String(r.step)}`);
    if (r.errorClass) console.log(`error       ${r.errorClass}: ${r.error ?? ""}`);
    if (r.environment) console.log(`environment ${JSON.stringify(r.environment)}`);
    if (r.observedRows !== undefined) console.log(`observed    ${r.observedRows} rows`);
    if (r.timings && Object.keys(r.timings).length > 0) console.log(`timings     ${JSON.stringify(r.timings)}`);
    if (r.heartbeatAt) console.log(`heartbeat   ${new Date(Number(r.heartbeatAt)).toISOString()}`);
    return;
  }

  console.log(`\n  ${shardCount} shards\n`);
  console.log(`    ${"shard".padEnd(7)} ${"step".padEnd(14)} ${"cands".padEnd(6)} ${"rows".padEnd(5)} error`);
  for (const r of shards) {
    const err = r.errorClass ? `${r.errorClass}: ${(r.error ?? "").slice(0, 80)}` : "";
    console.log(
      `    ${String(r.shardIndex ?? "?").padEnd(7)} ${String(r.step ?? "?").padEnd(14)} ` +
        `${String(r.selectableCandidates ?? "-").padEnd(6)} ${String(r.resultRows ?? "-").padEnd(5)} ${err}`,
    );
  }
  const done = shards.filter((r) => r.step === "done").length;
  const failed = shards.filter((r) => r.step === "failed").length;
  console.log(`\n  ${done}/${shardCount} done, ${failed} failed\n`);
}

/**
 * Pull a collected run down into the same shape a local run produces, so `dogfood:freeze` reads it
 * without knowing it came from a container.
 *
 * A SHARDED run is merged here, and the merge is where the danger is. A shard that died quietly would
 * simply contribute no rows, the funnel's denominator would shrink, and eighteen candidates would read
 * as a clean result rather than a broken experiment - the same shape of failure as the empty run and
 * the mislabelled corpus before it. So every shard must be present, every shard must be `done`, the
 * merged row count must equal the sum of what the shards said they would attempt, and every shard must
 * report the same environment. Any of those failing refuses the collection outright.
 */
async function cmdCollect(args: Record<string, string>): Promise<void> {
  const runId = args["run-id"] ?? fail("collect requires --run-id");
  const files = ["manifest.json", "results.jsonl", "COMPLETE", "corpus.jsonl", "environment.json", "observe.log", "mutate.log"];

  const { shardCount, shards } = await fetchState(args, runId);

  const missing = shards.filter((r) => r.step !== "done");
  if (missing.length > 0) {
    const detail = missing.map((r) => `shard ${r.shardIndex ?? "?"}: ${r.step ?? "missing"}${r.errorClass ? ` (${r.errorClass})` : ""}`).join("; ");
    fail(`refusing to collect ${runId}: ${missing.length} of ${shardCount} shard(s) did not finish - ${detail}`);
  }

  const perShard: { index: number; fetched: Record<string, string> }[] = [];
  for (let index = 0; index < shardCount; index++) {
    const suffix = shardCount > 1 ? `&shard=${index}` : "";
    const fetched: Record<string, string> = {};
    for (const file of files) {
      const res = await api(args, `/v1/result?runId=${encodeURIComponent(runId)}&file=${encodeURIComponent(file)}${suffix}`);
      if (res.status === 404) continue;
      if (!res.ok) fail(`fetching ${file} for shard ${index} failed: ${res.status} ${await res.text()}`);
      fetched[file] = await res.text();
    }
    for (const required of ["manifest.json", "results.jsonl", "COMPLETE"]) {
      if (fetched[required] === undefined) fail(`shard ${index} of ${runId} is missing ${required} - it did not complete`);
    }
    perShard.push({ index, fetched });
  }

  const rows = perShard.flatMap((s) => s.fetched["results.jsonl"]!.split("\n").filter((l) => l.trim().length > 0));

  // A COMPLETE run that classified nothing is a silent no-op, not a result.
  if (rows.length === 0) {
    fail(`run ${runId} completed but classified nothing (no result rows across ${shardCount} shard(s)). Refusing to collect it as evidence.`);
  }

  // The merge guard. Each shard declared how many candidates it would attempt before it ran; the merged
  // rows must account for all of them.
  const expected = shards.reduce((sum, r) => sum + (r.selectableCandidates ?? 0), 0);
  if (expected > 0 && rows.length !== expected) {
    fail(`refusing to collect ${runId}: shards declared ${expected} candidate(s) but the merge produced ${rows.length} row(s). Evidence is missing and the funnel would silently under-report.`);
  }
  const declaredTotal = shards.map((r) => r.totalSelectableCandidates).find((t) => typeof t === "number");
  if (typeof declaredTotal === "number" && expected !== declaredTotal) {
    fail(`refusing to collect ${runId}: shards cover ${expected} of ${declaredTotal} selectable candidate(s) - the split lost work.`);
  }

  // Evidence from two different toolchains is not one experiment.
  const envs = new Set(
    perShard
      .map((s) => (s.fetched["environment.json"] ? (JSON.parse(s.fetched["environment.json"]) as { environment?: { image?: string; node?: string } }).environment : undefined))
      .filter(Boolean)
      .map((e) => `${e!.image} / ${e!.node}`),
  );
  if (envs.size > 1) {
    fail(`refusing to collect ${runId}: shards ran in different environments (${[...envs].join(" | ")}). Their rows are not one experiment.`);
  }

  const baseManifest = JSON.parse(perShard[0]!.fetched["manifest.json"]!) as Record<string, unknown>;
  const localRunId = shardCount > 1 ? `${runId}-merged` : String(baseManifest.runId ?? runId);
  const outDir = resolve(args.out ?? join(REPO_ROOT, ".dogfood", "runs", localRunId));
  mkdirSync(outDir, { recursive: true });

  writeFileSync(join(outDir, "results.jsonl"), `${rows.join("\n")}\n`);
  writeFileSync(join(outDir, "COMPLETE"), perShard[0]!.fetched["COMPLETE"]!);
  if (perShard[0]!.fetched["corpus.jsonl"]) writeFileSync(join(outDir, "corpus.jsonl"), perShard[0]!.fetched["corpus.jsonl"]!);

  if (shardCount === 1) {
    // Written EXACTLY as the container produced it, container-side corpusPath and all. Rewriting that
    // would make the manifest describe a run that never happened.
    writeFileSync(join(outDir, "manifest.json"), perShard[0]!.fetched["manifest.json"]!);
  } else {
    // A merged run had no single process, so it gets a manifest that says so and carries every shard's
    // own manifest verbatim, rather than one shard's manifest pretending to describe all of them.
    const merged = {
      ...baseManifest,
      runId: localRunId,
      merged: true,
      shardCount,
      candidates: rows.length,
      shardManifests: perShard.map((s) => JSON.parse(s.fetched["manifest.json"]!) as unknown),
      note: "Merged from independent shard runs. Each shard observed the full pinned corpus and mutated its own slice; timings are per shard and are not additive.",
    };
    writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(merged, null, 2)}\n`);
  }

  for (const s of perShard) {
    if (s.fetched["environment.json"]) writeFileSync(join(outDir, shardCount > 1 ? `environment.${s.index}.json` : "environment.json"), s.fetched["environment.json"]);
    for (const log of ["observe.log", "mutate.log"]) {
      if (s.fetched[log]) writeFileSync(join(outDir, shardCount > 1 ? `${log}.${s.index}` : log), s.fetched[log]!);
    }
  }

  console.log(`\nCollected ${rows.length} row(s) from ${shardCount} shard(s) into ${outDir}\n`);
  console.log(`  environment: ${[...envs][0] ?? "(not recorded)"}`);
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
