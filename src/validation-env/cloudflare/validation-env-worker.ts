/**
 * diffci-validation-env - the control plane for the canonical Linux validation environment (2026-08-28).
 *
 * Deliberately a SEPARATE Worker from `diffci-analysis-fanout`. The fanout Worker carries the frozen
 * engine checksums, the execution-validation state machines and the safety-budget stores that a long
 * line of reports already depends on; adding an unrelated experiment host to it would put that machinery
 * one deploy away from an unrelated mistake. This Worker shares only the account, the container image
 * and the patterns.
 *
 * Exports:
 *  - `Sandbox as ValidationContainer` - the container class the platform instantiates.
 *  - `ValidationShard` - one alarm-driven DO per run, holding the observe -> mutate pipeline.
 *  - default `{ fetch }` - the control plane:
 *      GET  /v1/jobs                  list the allowlisted jobs
 *      POST /v1/start                 seed a run  { runId, jobId, sourceTarballKey, sourceTarballSha256, agentTarballKey }
 *      GET  /v1/state?runId=...       the run record
 *      POST /v1/cancel                stop a run
 *      GET  /v1/result?runId=&file=   read one collected artefact back out of R2
 *
 * A request never carries a command. It carries a job id, which is looked up in the allowlist - see
 * validation-jobs.ts for why that distinction is the whole security model here.
 */
import { Sandbox } from "@cloudflare/sandbox";

import type { R2BucketLike } from "../../analysis-fanout/sandbox-like.js";
import { MAX_SHARDS, getValidationJob, listValidationJobs } from "../validation-jobs.js";
import { ValidationShard } from "./validation-shard-do.js";

export { Sandbox as ValidationContainer };
export { ValidationShard };

interface Env {
  VALIDATION_SHARD: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
  VALIDATION_BUCKET: R2BucketLike;
  /** Set with `wrangler secret put VALIDATION_CONTROL_TOKEN`. Never committed. */
  VALIDATION_CONTROL_TOKEN?: string;
}

/** Length-independent comparison, so a wrong token leaks nothing through timing. */
function tokensMatch(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function authorized(request: Request, expected?: string): boolean {
  // Fail closed. With no token configured the control plane is unusable rather than open.
  if (!expected) return false;
  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  return tokensMatch(header.slice(prefix.length), expected);
}

/** Run ids name a Durable Object and appear in R2 keys, so the character set is restricted. */
function isRunId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value);
}

/**
 * The Durable Object name for one shard.
 *
 * An unsharded run keeps the bare runId it has always used, so runs started before sharding existed
 * remain addressable by exactly the same name.
 */
function shardName(runId: string, index: number, shardCount: number): string {
  return shardCount > 1 ? `${runId}-s${index}` : runId;
}

/** Only the artefacts the shard itself writes are readable back. */
const COLLECTED_FILES: ReadonlySet<string> = new Set([
  // Reproduction runs.
  "manifest.json",
  "results.jsonl",
  "COMPLETE",
  "corpus.jsonl",
  "observe.log",
  "mutate.log",
  // Qualification runs. The updated corpus registry IS the verdict, and the log carries the reason a
  // failed qualification failed - which is the whole point of running one. Omitting these (2026-08-29)
  // left a completed run whose artefacts were written to R2 and then unreadable through the only route
  // that can read them.
  "corpus-definition.json",
  "qualify.log",
  // Calibration runs.
  "calibration.log",
  // Addressability survey. Same omission as the qualification artefacts above, made again on
  // 2026-08-30: the run completed, wrote its funnel to R2, and the only route that can read it
  // refused. A write path and a read allowlist that are edited separately will keep diverging, so
  // the facts endpoint below is a prefix match rather than yet another name to forget.
  "survey-summary.json",
  "survey.log",
  // Density survey. Added with the writer, not after it.
  "density-summary.json",
  "density-rows.json",
  "density.log",
  // Both.
  "environment.json",
]);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, worker: "diffci-validation-env", jobs: listValidationJobs() });
    }

    if (!authorized(request, env.VALIDATION_CONTROL_TOKEN)) {
      return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }

    try {
      if (request.method === "GET" && url.pathname === "/v1/jobs") {
        return Response.json({ ok: true, jobs: listValidationJobs().map((id) => getValidationJob(id)) });
      }

      if (request.method === "POST" && url.pathname === "/v1/start") {
        const body = (await request.json()) as Record<string, unknown>;
        const { runId, jobId, sourceTarballKey, sourceTarballSha256, agentTarballKey } = body;

        if (!isRunId(runId)) return Response.json({ ok: false, error: "invalid-run-id" }, { status: 400 });
        if (typeof jobId !== "string" || !getValidationJob(jobId)) {
          return Response.json({ ok: false, error: `unknown-job (allowed: ${listValidationJobs().join(", ")})` }, { status: 400 });
        }
        if (typeof sourceTarballKey !== "string" || typeof agentTarballKey !== "string") {
          return Response.json({ ok: false, error: "sourceTarballKey and agentTarballKey are required" }, { status: 400 });
        }
        if (typeof sourceTarballSha256 !== "string" || !/^[0-9a-f]{64}$/.test(sourceTarballSha256)) {
          return Response.json({ ok: false, error: "sourceTarballSha256 must be 64 lowercase hex" }, { status: 400 });
        }

        // Sharding splits the CANDIDATES, not the observation: every shard observes the full pinned
        // corpus (deterministic once history is fixed) and mutates only its own slice. More shards is
        // not automatically faster - each one clones and installs the target independently, so past a
        // point the fixed setup dominates. See MAX_SHARDS.
        const shardCount = body.shards === undefined ? 1 : Number(body.shards);
        if (!Number.isInteger(shardCount) || shardCount < 1 || shardCount > MAX_SHARDS) {
          return Response.json({ ok: false, error: `shards must be an integer 1..${MAX_SHARDS}` }, { status: 400 });
        }

        const seeded = await Promise.all(
          Array.from({ length: shardCount }, async (_unused, index) => {
            const stub = env.VALIDATION_SHARD.get(env.VALIDATION_SHARD.idFromName(shardName(runId, index, shardCount)));
            const res = await stub.fetch(
              new Request("https://do/start", {
                method: "POST",
                body: JSON.stringify({
                  runId,
                  jobId,
                  sourceTarballKey,
                  sourceTarballSha256,
                  agentTarballKey,
                  shardIndex: index,
                  shardCount,
                }),
              }),
            );
            return res.json();
          }),
        );

        return Response.json({ ok: true, runId, shardCount, shards: seeded });
      }

      if (request.method === "GET" && url.pathname === "/v1/state") {
        const runId = url.searchParams.get("runId");
        if (!isRunId(runId)) return Response.json({ ok: false, error: "invalid-run-id" }, { status: 400 });

        // The caller should not have to remember how a run was sharded. An unsharded run answers under
        // its bare name; otherwise shard 0's own record carries the shard count, which is enough to find
        // the rest.
        const unsharded = await env.VALIDATION_SHARD.get(env.VALIDATION_SHARD.idFromName(runId)).fetch(new Request("https://do/state"));
        if (unsharded.ok) return unsharded;

        const first = await env.VALIDATION_SHARD.get(env.VALIDATION_SHARD.idFromName(shardName(runId, 0, 2))).fetch(new Request("https://do/state"));
        if (!first.ok) return Response.json({ ok: false, error: "not-found" }, { status: 404 });
        const firstRecord = (await first.json()) as { shardCount?: number };
        const shardCount = firstRecord.shardCount ?? 1;

        const shards = await Promise.all(
          Array.from({ length: shardCount }, async (_unused, index) => {
            const res = await env.VALIDATION_SHARD.get(env.VALIDATION_SHARD.idFromName(shardName(runId, index, shardCount))).fetch(
              new Request("https://do/state"),
            );
            return res.ok ? await res.json() : { shardIndex: index, step: "missing" };
          }),
        );
        return Response.json({ ok: true, runId, shardCount, shards });
      }

      if (request.method === "POST" && url.pathname === "/v1/cancel") {
        const body = (await request.json()) as { runId?: unknown };
        if (!isRunId(body.runId)) return Response.json({ ok: false, error: "invalid-run-id" }, { status: 400 });
        const stub = env.VALIDATION_SHARD.get(env.VALIDATION_SHARD.idFromName(body.runId));
        return stub.fetch(new Request("https://do/cancel", { method: "POST" }));
      }

      if (request.method === "GET" && url.pathname === "/v1/result") {
        const runId = url.searchParams.get("runId");
        const file = url.searchParams.get("file") ?? "";
        if (!isRunId(runId)) return Response.json({ ok: false, error: "invalid-run-id" }, { status: 400 });
        // `facts/<name>.json` is the survey's per-entry evidence: one file per frame entry, named by
        // rank and package. A prefix rule rather than 40 allowlist entries, constrained so it cannot
        // address anything outside that directory.
        const isSurveyFact = /^facts\/[0-9]{2}-[A-Za-z0-9_.@-]+\.json$/.test(file);
        // Evidence preserved from a FAILED run (defect #16). Added here at the same time as the write
        // path, because #14 was this allowlist lagging behind a writer and #4 was the same thing again.
        const isPreserved = /^failed\/[A-Za-z0-9_.@-]+\.(json|jsonl|log)$/.test(file);
        if (!COLLECTED_FILES.has(file) && !isSurveyFact && !isPreserved) {
          return Response.json({ ok: false, error: `unknown-file (allowed: ${[...COLLECTED_FILES].join(", ")}, facts/NN-name.json, failed/*.{json,jsonl,log})` }, { status: 400 });
        }
        // `shard` addresses one shard's artefacts; omitted reads an unsharded run's flat layout.
        const shardParam = url.searchParams.get("shard");
        let prefix = `validation/${runId}`;
        if (shardParam !== null) {
          const shard = Number(shardParam);
          if (!Number.isInteger(shard) || shard < 0 || shard >= MAX_SHARDS) {
            return Response.json({ ok: false, error: `shard must be an integer 0..${MAX_SHARDS - 1}` }, { status: 400 });
          }
          prefix = `validation/${runId}/shards/${shard}`;
        }

        const object = await env.VALIDATION_BUCKET.get(`${prefix}/${file}`);
        if (!object) return Response.json({ ok: false, error: "not-found" }, { status: 404 });
        return new Response(await object.text(), { headers: { "content-type": "text/plain; charset=utf-8" } });
      }

      return Response.json({ ok: false, error: "not-found" }, { status: 404 });
    } catch (err) {
      return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
    }
  },
};
