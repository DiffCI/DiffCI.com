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
import { getValidationJob, listValidationJobs } from "../validation-jobs.js";
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

/** Only the artefacts the shard itself writes are readable back. */
const COLLECTED_FILES: ReadonlySet<string> = new Set([
  "manifest.json",
  "results.jsonl",
  "COMPLETE",
  "corpus.jsonl",
  "environment.json",
  "observe.log",
  "mutate.log",
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

        const stub = env.VALIDATION_SHARD.get(env.VALIDATION_SHARD.idFromName(runId));
        return stub.fetch(
          new Request("https://do/start", {
            method: "POST",
            body: JSON.stringify({ runId, jobId, sourceTarballKey, sourceTarballSha256, agentTarballKey }),
          }),
        );
      }

      if (request.method === "GET" && url.pathname === "/v1/state") {
        const runId = url.searchParams.get("runId");
        if (!isRunId(runId)) return Response.json({ ok: false, error: "invalid-run-id" }, { status: 400 });
        const stub = env.VALIDATION_SHARD.get(env.VALIDATION_SHARD.idFromName(runId));
        return stub.fetch(new Request("https://do/state"));
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
        if (!COLLECTED_FILES.has(file)) {
          return Response.json({ ok: false, error: `unknown-file (allowed: ${[...COLLECTED_FILES].join(", ")})` }, { status: 400 });
        }
        const object = await env.VALIDATION_BUCKET.get(`validation/${runId}/${file}`);
        if (!object) return Response.json({ ok: false, error: "not-found" }, { status: 404 });
        return new Response(await object.text(), { headers: { "content-type": "text/plain; charset=utf-8" } });
      }

      return Response.json({ ok: false, error: "not-found" }, { status: 404 });
    } catch (err) {
      return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
    }
  },
};
