/**
 * DiffCI Cloudflare-Sandbox analysis fan-out Worker (2026-08-23).
 *
 * This is the product-path horizontal fan-out: the same Worker that runs the frozen blind
 * multi-repository baseline now will later fan out customer pull requests across N Sandbox
 * containers concurrently. It is a SEPARATE deployment from diffci-research-sandbox and
 * diffci-synthetic-runner; it shares only the public base image `docker.io/cloudflare/sandbox:0.12.5`.
 *
 * Layout:
 *  - `export { Sandbox as AnalysisShardContainer }` - the container DO class the platform instantiates.
 *  - `export { AnalysisShard }` - the alarm-driven shard state machine (one DO per shard).
 *  - `export { AnalysisRun }` - the coordinator DO (one per runId) holding run/shard state + watchdog.
 *  - `default export { fetch }` - the control plane:
 *      POST /v1/run                 -> validate + gate (R2 tarball hash + frozen manifest) + hand off
 *      GET  /v1/run/:runId          -> shard table (read from the coordinator DO)
 *      POST /v1/run/:runId/cancel   -> cancel a run
 *      GET  /v1/run/:runId/rows     -> collector: concatenated shard rows ordered by manifest index
 *
 * Execution validation (2026-08-24) - a sibling capability of this SAME Worker/deployment, not a new
 * one, per the explicit instruction to extend analysis-fanout rather than stand up something separate:
 *  - `export { AnalysisExecutionShard }` - one alarm-driven DO per (repo, mergeSha) that installs and
 *    actually runs the target repository's own test commands - full suite + DiffCI-selected subset -
 *    before and after one generic mutation, to measure real wall time and failure-detection recall.
 *      POST /v1/execute                                 -> validate + gate (repo must be configured in
 *                                                           repo-execution-profiles.ts) + start one shard
 *      GET  /v1/execute/:runId/:repo/:mergeSha           -> that shard's current ExecutionRecord
 *      POST /v1/execute/:runId/:repo/:mergeSha/cancel    -> cancel that shard
 * This never touches the frozen engine or the analyze-mode shard/coordinator above - it consumes an
 * already-produced selection (an ExecutionSpec) as input.
 *
 * Orchestration note: there is NO `ctx.waitUntil(runFanOut(...))` here any more. The Worker's only job
 * is to validate the request, re-verify the tarball/frozen-manifest checksums, and hand the run to the
 * AnalysisRun Durable Object via `/init` with the full shard seeds. The coordinator's own alarm-driven
 * state machine releases shards (bounded by maxConcurrentShards) by POSTing each shard's seed to the
 * AnalysisShard DO `/start`, and the shard DO runs its own alarm-driven `bootstrapping -> cloning ->
 * analyzing -> finalizing -> done|failed|cancelled` state machine.
 *
 * The engine itself (src/repo/*, src/git/*, scripts/diffci-benchmark-external.ts,
 * scripts/diffci-blind-baseline.ts) is FROZEN. This Worker only bootstraps it into a container from a
 * source tarball, verifies the frozen engine checksum, and drives the unmodified replay driver with a
 * deterministic per-shard slice manifest.
 */
import { buildIndexLookup, concatenateShards, parseRows, type Row } from "../collector.js";
import { buildShardSlices } from "../shard-slice.js";
import { hexMatches, sha256Hex } from "../checksum.js";
import type {
  PackRecord,
  RepositorySpec,
  RunRequest,
  RunState,
  SelectionManifest,
  ShardRecord,
  ShardState,
} from "../fanout-types.js";
import type { InitPayload } from "./analysis-run-do.js";
import type { ExecutionSpec } from "../execution-types.js";
import { getRepoExecutionProfile, listConfiguredRepositories } from "../repo-execution-profiles.js";

export { Sandbox as AnalysisShardContainer } from "@cloudflare/sandbox";
export { AnalysisShard } from "./analysis-shard-do.js";
export { AnalysisRun } from "./analysis-run-do.js";
export { AnalysisExecutionShard } from "./execution-shard-do.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DONamespace = any; // matches validation-worker.ts's idiom - no @cloudflare/workers-types dependency here

/** Minimal R2 structural typing (this project does not depend on @cloudflare/workers-types). */
interface R2ObjectBody {
  key: string;
  size: number;
  body: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}
interface R2ListResult {
  objects: { key: string; size: number }[];
  truncated?: boolean;
  cursor?: string;
}
interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  put(
    key: string,
    value: string | ArrayBuffer | Uint8Array | ReadableStream,
    opts?: Record<string, unknown>,
  ): Promise<unknown>;
  list(opts?: { prefix?: string; limit?: number; cursor?: string }): Promise<R2ListResult>;
}

interface Env {
  ANALYSIS_RUN: DONamespace;
  ANALYSIS_EXECUTION_SHARD: DONamespace;
  ANALYSIS_BUCKET: R2Bucket;
  ANALYSIS_CONTROL_TOKEN?: string;
  FROZEN_MANIFEST_KEY?: string;
}

interface ExecutionCtx {
  waitUntil(promise: Promise<unknown>): void;
}

interface DOStub {
  fetch(request: Request): Promise<Response>;
}

const DEFAULT_FROZEN_MANIFEST_KEY = "manifests/2026-08-23-diffci-frozen-build-manifest.json";
// Informational label only - reported in run/status responses, does NOT control the actual container
// shape (that's wrangler.analysis-fanout.jsonc's `instance_type`). Bumped 2026-08-24 alongside the
// standard-2 -> standard-4 redeploy; kept in sync manually since the Sandbox binding has no runtime API
// to read its own configured instance_type. The live-shape probe (record.probe / memAvailableBeforeMb
// in each shard's heartbeat) is the trustworthy source - this constant was stale (still "standard-2")
// through the first post-redeploy probe run and only the memory probe caught it.
const SHAPE = "standard-4";

function json(payload: unknown, status = 200): Response {
  return Response.json(payload, { status, headers: { "Cache-Control": "no-store" } });
}

async function authorized(request: Request, expected?: string): Promise<boolean> {
  if (!expected) return false;
  return (request.headers.get("Authorization") || "") === `Bearer ${expected}`;
}

async function readJson(bucket: R2Bucket, key: string): Promise<Record<string, unknown> | null> {
  const obj = await bucket.get(key);
  if (!obj) return null;
  try {
    return JSON.parse(await obj.text()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getDoStub(env: Env, runId: string): DOStub {
  const ns = env.ANALYSIS_RUN as DONamespace;
  return ns.get(ns.idFromName(runId)) as DOStub;
}

function executionShardKey(runId: string, repository: string, mergeSha: string): string {
  return `${runId}:${repository}:${mergeSha}`;
}

function getExecutionDoStub(env: Env, runId: string, repository: string, mergeSha: string): DOStub {
  const ns = env.ANALYSIS_EXECUTION_SHARD as DONamespace;
  return ns.get(ns.idFromName(executionShardKey(runId, repository, mergeSha))) as DOStub;
}

function repoSlug(repo: string): string {
  return repo.replace("/", "__");
}

function packRecordKey(runId: string): string {
  return `manifests/${runId}/pack-record.json`;
}

async function collectRows(env: Env, runId: string, repositoryFilter?: string): Promise<Response> {
  const stateResp = await getDoStub(env, runId).fetch(new Request("https://do/state"));
  const state = (await stateResp.json()) as RunState | { ok: false };
  if (!("repositories" in state)) return json({ ok: false, error: "run not found" }, 404);

  const repos = repositoryFilter
    ? state.repositories.filter((r) => r.name === repositoryFilter || r.manifestKey === repositoryFilter)
    : state.repositories;
  if (repositoryFilter && repos.length === 0) return json({ ok: false, error: `repository not in run: ${repositoryFilter}` }, 404);

  const out: string[] = [];
  for (const repo of repos) {
    const manifest = (await readJson(env.ANALYSIS_BUCKET, repo.manifestKey)) as unknown as SelectionManifest | null;
    const indexLookup = manifest ? buildIndexLookup(manifest) : new Map<string, number>();
    const slug = repoSlug(repo.name);
    const listed = await env.ANALYSIS_BUCKET.list({ prefix: `runs/${runId}/${slug}/shard-`, limit: 1000 });
    const shardRows: Row[] = [];
    for (const obj of listed.objects) {
      if (!obj.key.endsWith(".jsonl")) continue;
      const o = await env.ANALYSIS_BUCKET.get(obj.key);
      if (!o) continue;
      shardRows.push(...parseRows(await o.text()));
    }
    out.push(...concatenateShards([shardRows], indexLookup).map((r) => JSON.stringify(r)));
  }

  return new Response(out.join("\n") + (out.length ? "\n" : ""), {
    headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" },
  });
}

async function handleCreateRun(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as RunRequest & Record<string, unknown>;
  const runId = body.runId;
  const repositories = body.repositories;
  const shardsPerRepository = body.shardsPerRepository;
  const maxConcurrentShards = typeof body.maxConcurrentShards === "number" ? body.maxConcurrentShards : 8;

  if (typeof runId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(runId)) {
    return json({ ok: false, error: "runId must match ^[a-zA-Z0-9_-]{1,128}$" }, 400);
  }
  if (!Array.isArray(repositories) || repositories.length === 0) {
    return json({ ok: false, error: "repositories must be a non-empty array" }, 400);
  }
  if (!Number.isInteger(shardsPerRepository) || (shardsPerRepository as number) < 1) {
    return json({ ok: false, error: "shardsPerRepository must be a positive integer" }, 400);
  }
  if (!Number.isInteger(maxConcurrentShards) || maxConcurrentShards < 1) {
    return json({ ok: false, error: "maxConcurrentShards must be a positive integer" }, 400);
  }

  // 1. The pack record is the single source of truth for the tarball's identity.
  const packKey = packRecordKey(runId);
  const pack = (await readJson(env.ANALYSIS_BUCKET, packKey)) as unknown as PackRecord | null;
  if (!pack || typeof pack.tarballKey !== "string" || typeof pack.tarballSha256 !== "string") {
    return json({ ok: false, error: "pack-record-missing", key: packKey }, 400);
  }

  // 2. Worker-side R2 tarball hash gate: re-hash the R2 object and compare to the pack record (a
  //    client-supplied checksum string is never trusted).
  const tar = await env.ANALYSIS_BUCKET.get(pack.tarballKey);
  if (!tar) return json({ ok: false, error: "tarball-missing", key: pack.tarballKey }, 400);
  const actualTarballSha = await sha256Hex(await tar.arrayBuffer());
  if (!hexMatches(actualTarballSha, pack.tarballSha256)) {
    return json({ ok: false, error: "tarball-checksum-mismatch", provided: actualTarballSha, expected: pack.tarballSha256 }, 400);
  }

  // 3. Frozen-manifest gate: the pack record's engineChecksum must match the R2 copy of the frozen
  //    build manifest (consistency check; the tarball hash above is the primary gate).
  const frozenKey = pack.frozenManifestKey ?? env.FROZEN_MANIFEST_KEY ?? DEFAULT_FROZEN_MANIFEST_KEY;
  const frozen = await readJson(env.ANALYSIS_BUCKET, frozenKey);
  if (!frozen || typeof frozen.engineChecksum !== "string") {
    return json({ ok: false, error: "frozen-build-manifest-missing", key: frozenKey }, 400);
  }
  if (!hexMatches(pack.engineChecksum, frozen.engineChecksum)) {
    return json({ ok: false, error: "engine-checksum-mismatch", provided: pack.engineChecksum, expected: frozen.engineChecksum }, 400);
  }

  // 4. Build the shard seeds (full ShardRecord) and the coordinator's ShardState rows.
  const now = Date.now();
  const shardSeeds: ShardRecord[] = [];
  const shards: ShardState[] = [];
  for (const repo of repositories as RepositorySpec[]) {
    if (typeof repo?.name !== "string" || typeof repo?.manifestKey !== "string") {
      return json({ ok: false, error: "each repository needs { name, manifestKey }" }, 400);
    }
    const manifest = (await readJson(env.ANALYSIS_BUCKET, repo.manifestKey)) as unknown as SelectionManifest | null;
    if (!manifest || !Array.isArray(manifest.merges)) {
      return json({ ok: false, error: `manifest missing or malformed: ${repo.manifestKey}` }, 400);
    }
    for (const slice of buildShardSlices(manifest, shardsPerRepository as number)) {
      const id = `${runId}:${repo.name}:${slice.shardIndex}`;
      const sandboxId = `${runId}-${repoSlug(repo.name)}-sh${slice.shardIndex}`.toLowerCase();
      shardSeeds.push({
        id,
        runId,
        repo: repo.name,
        manifestKey: repo.manifestKey,
        tarballKey: pack.tarballKey,
        tarballSha256: pack.tarballSha256,
        frozenManifestKey: frozenKey,
        slice,
        shardIndex: slice.shardIndex,
        shardCount: slice.shardCount,
        mergeCount: slice.merges.length,
        step: "bootstrapping",
        sandboxId,
        flushedLines: 0,
        rows: [],
        timings: {},
        startedAt: now,
        heartbeatAt: now,
      });
      shards.push({
        id,
        runId,
        repo: repo.name,
        shardIndex: slice.shardIndex,
        shardCount: slice.shardCount,
        mergeCount: slice.merges.length,
        status: "pending",
        rowsCompleted: 0,
        heartbeatAt: now,
        timings: {},
      });
    }
  }

  const init: InitPayload = {
    runId,
    createdAt: now,
    shape: SHAPE,
    shardsPerRepository: shardsPerRepository as number,
    maxConcurrentShards,
    repositories: repositories as RepositorySpec[],
    engineChecksum: pack.engineChecksum,
    tarballKey: pack.tarballKey,
    tarballSha256: pack.tarballSha256,
    shards,
    shardSeeds,
  };
  const doStub = getDoStub(env, runId);
  const initResp = await doStub.fetch(new Request("https://do/init", { method: "POST", body: JSON.stringify(init) }));
  if (initResp.status !== 200) return json(await initResp.json(), initResp.status);

  // No ctx.waitUntil: the AnalysisRun DO's alarm-driven state machine does all long-running work.
  return json({
    ok: true,
    runId,
    shape: SHAPE,
    shardCount: shards.length,
    maxConcurrentShards,
    shards: shards.map((s) => ({ id: s.id, repo: s.repo, shardIndex: s.shardIndex, shardCount: s.shardCount, mergeCount: s.mergeCount })),
  });
}

async function handleCreateExecution(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as Partial<ExecutionSpec> & Record<string, unknown>;
  const runId = body.runId;
  const repository = body.repository;
  const mergeSha = body.mergeSha;
  const baseSha = body.baseSha;
  const selectedTestPaths = body.selectedTestPaths;

  if (typeof runId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(runId)) {
    return json({ ok: false, error: "runId must match ^[a-zA-Z0-9_-]{1,128}$" }, 400);
  }
  if (typeof repository !== "string" || !repository.includes("/")) {
    return json({ ok: false, error: "repository must be \"owner/name\"" }, 400);
  }
  if (typeof mergeSha !== "string" || !/^[0-9a-f]{7,40}$/.test(mergeSha)) {
    return json({ ok: false, error: "mergeSha must be a hex commit sha" }, 400);
  }
  if (typeof baseSha !== "string" || !/^[0-9a-f]{7,40}$/.test(baseSha)) {
    return json({ ok: false, error: "baseSha must be a hex commit sha" }, 400);
  }
  // Optional (2026-08-24): if omitted, the shard derives its own selection via the frozen engine
  // (deriving-selection step) instead of requiring a pre-computed analyze-mode row.
  if (selectedTestPaths !== undefined && !Array.isArray(selectedTestPaths)) {
    return json({ ok: false, error: "selectedTestPaths, if provided, must be an array" }, 400);
  }
  if (body.analysisOverheadMs !== undefined && (typeof body.analysisOverheadMs !== "number" || !Number.isFinite(body.analysisOverheadMs) || body.analysisOverheadMs < 0)) {
    return json({ ok: false, error: "analysisOverheadMs, if provided, must be a non-negative number" }, 400);
  }
  // Command-shape experimentation (2026-08-24): if provided, REPLACES the stored profile's testArgv for
  // this run only - the caller (never a target-repo file, never the profile itself) supplies the
  // candidate shape. Every element must be a plain string, same discipline as selectedTestPaths.
  if (body.testArgvOverride !== undefined && (!Array.isArray(body.testArgvOverride) || !body.testArgvOverride.every((a) => typeof a === "string"))) {
    return json({ ok: false, error: "testArgvOverride, if provided, must be an array of strings" }, 400);
  }
  // Reject before a container is ever provisioned - execution is never silently faked/approximated for
  // a repository whose real CI test command DiffCI has not verified (repo-execution-profiles.ts).
  if (!getRepoExecutionProfile(repository)) {
    return json({ ok: false, error: "not-configured", repository, configured: listConfiguredRepositories() }, 400);
  }

  // Same tarball/frozen-manifest verification gate as handleCreateRun - the caller only names a runId
  // whose pack record was already uploaded (via the `pack` CLI command); it never supplies a checksum
  // directly, so it can never bypass this gate.
  const packKey = packRecordKey(runId);
  const pack = (await readJson(env.ANALYSIS_BUCKET, packKey)) as unknown as PackRecord | null;
  if (!pack || typeof pack.tarballKey !== "string" || typeof pack.tarballSha256 !== "string") {
    return json({ ok: false, error: "pack-record-missing", key: packKey }, 400);
  }
  const tar = await env.ANALYSIS_BUCKET.get(pack.tarballKey);
  if (!tar) return json({ ok: false, error: "tarball-missing", key: pack.tarballKey }, 400);
  const actualTarballSha = await sha256Hex(await tar.arrayBuffer());
  if (!hexMatches(actualTarballSha, pack.tarballSha256)) {
    return json({ ok: false, error: "tarball-checksum-mismatch", provided: actualTarballSha, expected: pack.tarballSha256 }, 400);
  }
  const frozenKey = pack.frozenManifestKey ?? env.FROZEN_MANIFEST_KEY ?? DEFAULT_FROZEN_MANIFEST_KEY;
  const frozen = await readJson(env.ANALYSIS_BUCKET, frozenKey);
  if (!frozen || typeof frozen.engineChecksum !== "string") {
    return json({ ok: false, error: "frozen-build-manifest-missing", key: frozenKey }, 400);
  }
  if (!hexMatches(pack.engineChecksum, frozen.engineChecksum)) {
    return json({ ok: false, error: "engine-checksum-mismatch", provided: pack.engineChecksum, expected: frozen.engineChecksum }, 400);
  }

  const spec: ExecutionSpec = {
    runId,
    repository,
    mergeSha,
    baseSha,
    prNumber: typeof body.prNumber === "number" ? body.prNumber : null,
    subject: typeof body.subject === "string" ? body.subject : "",
    tarballKey: pack.tarballKey,
    tarballSha256: pack.tarballSha256,
    frozenManifestKey: frozenKey,
    engineChecksum: pack.engineChecksum,
    selectedTestPaths: selectedTestPaths as string[] | undefined,
    totalTestsInGraph: typeof body.totalTestsInGraph === "number" ? body.totalTestsInGraph : undefined,
    analysisOverheadMs: body.analysisOverheadMs,
    testArgvOverride: body.testArgvOverride as string[] | undefined,
  };

  const doStub = getExecutionDoStub(env, runId, repository, mergeSha);
  const startResp = await doStub.fetch(
    new Request("https://do/start", { method: "POST", body: JSON.stringify({ spec, shape: SHAPE }) }),
  );
  return json(await startResp.json(), startResp.status);
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionCtx): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const method = request.method;

    if (parts[0] !== "v1") return json({ ok: false, error: "not-found" }, 404);

    if (parts[1] === "execute") {
      // POST /v1/execute
      if (method === "POST" && parts.length === 2) {
        if (!(await authorized(request, env.ANALYSIS_CONTROL_TOKEN))) return json({ ok: false, error: "unauthorized" }, 401);
        return handleCreateExecution(request, env);
      }
      // GET  /v1/execute/:runId/:repoOwner/:repoName/:mergeSha
      // POST /v1/execute/:runId/:repoOwner/:repoName/:mergeSha/cancel
      const [, , runId, repoOwner, repoName, mergeSha, maybeCancel] = parts;
      if (runId && repoOwner && repoName && mergeSha) {
        const repository = `${repoOwner}/${repoName}`;
        if (!(await authorized(request, env.ANALYSIS_CONTROL_TOKEN))) return json({ ok: false, error: "unauthorized" }, 401);
        const isCancel = maybeCancel === "cancel";
        if (method === "GET" && !isCancel) {
          const resp = await getExecutionDoStub(env, runId, repository, mergeSha).fetch(new Request("https://do/state"));
          return json(await resp.json(), resp.status);
        }
        if (method === "POST" && isCancel) {
          const resp = await getExecutionDoStub(env, runId, repository, mergeSha).fetch(new Request("https://do/cancel", { method: "POST" }));
          return json(await resp.json(), resp.status);
        }
      }
      return json({ ok: false, error: "not-found" }, 404);
    }

    if (parts[1] !== "run") return json({ ok: false, error: "not-found" }, 404);

    // POST /v1/run
    if (method === "POST" && parts.length === 2) {
      if (!(await authorized(request, env.ANALYSIS_CONTROL_TOKEN))) return json({ ok: false, error: "unauthorized" }, 401);
      return handleCreateRun(request, env);
    }

    const runId = parts[2];
    if (!runId) return json({ ok: false, error: "not-found" }, 404);

    // GET /v1/run/:runId
    if (method === "GET" && parts.length === 3) {
      if (!(await authorized(request, env.ANALYSIS_CONTROL_TOKEN))) return json({ ok: false, error: "unauthorized" }, 401);
      const resp = await getDoStub(env, runId).fetch(new Request("https://do/state"));
      return json(await resp.json());
    }

    // POST /v1/run/:runId/cancel
    if (method === "POST" && parts[3] === "cancel") {
      if (!(await authorized(request, env.ANALYSIS_CONTROL_TOKEN))) return json({ ok: false, error: "unauthorized" }, 401);
      const resp = await getDoStub(env, runId).fetch(new Request("https://do/cancel", { method: "POST" }));
      return json(await resp.json());
    }

    // GET /v1/run/:runId/rows - collector: concatenated shard rows ordered by manifest index.
    if (method === "GET" && parts[3] === "rows") {
      if (!(await authorized(request, env.ANALYSIS_CONTROL_TOKEN))) return json({ ok: false, error: "unauthorized" }, 401);
      return collectRows(env, runId, url.searchParams.get("repository") ?? undefined);
    }

    return json({ ok: false, error: "not-found" }, 404);
  },
};