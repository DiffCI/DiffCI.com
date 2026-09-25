import type { D1Binding } from "../product/store.js";
import { hashOpaque, clientBucket, readBoundedText, takeRateLimit, BodyLimitError } from "../hosted/limits.js";
import { analyzePublicRepository, parsePublicRepository, type CompatibilityReport } from "./analyze.js";

export const CONSENT_VERSION = "public-metadata-v1";
export const RESULT_LIFETIME_MS = 24 * 3600000;
interface Job { id: string; repository: string; lease_id: string; attempts: number }
export interface DiagnosticEnv { db: D1Binding; enabled: boolean; rateSecret?: string; fetchImpl?: typeof fetch }
function json(value: unknown, status = 200, retry?: string): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff", ...(retry ? { "Retry-After": retry } : {}) } });
}

/** One durable job per invocation. A crash loses the lease, not the job; late completions are fenced. */
export async function drainDiagnosticQueue(env: DiagnosticEnv, now = Date.now()): Promise<void> {
  await env.db.prepare("DELETE FROM public_diagnostic_jobs WHERE expires_at <= ?").bind(now).run();
  await env.db.prepare("DELETE FROM hosted_request_limits WHERE expires_at <= ?").bind(now).run();
  if (!env.enabled) return;
  await env.db.prepare(`UPDATE public_diagnostic_jobs SET state = 'failed', error = 'attempts_exhausted', lease_id = NULL
    WHERE state IN ('queued','running') AND attempts >= 2 AND (lease_until IS NULL OR lease_until <= ?)`)
    .bind(now).run();
  const candidate = await env.db.prepare(`SELECT id FROM public_diagnostic_jobs WHERE expires_at > ? AND attempts < 2
    AND (state = 'queued' OR (state = 'running' AND lease_until <= ?)) ORDER BY created_at LIMIT 1`)
    .bind(now, now).first<{ id: string }>();
  if (!candidate) return;
  // Each attempt makes <= 6 public GitHub calls; this global budget bounds total upstream work.
  if (!await takeRateLimit(env.db, "diagnostic:attempts", 8, 3600, now)) return;
  const lease = crypto.randomUUID();
  const job = await env.db.prepare(`UPDATE public_diagnostic_jobs SET state = 'running', attempts = attempts + 1, lease_id = ?, lease_until = ?
    WHERE id = ? AND expires_at > ? AND attempts < 2 AND (state = 'queued' OR (state = 'running' AND lease_until <= ?)) RETURNING *`)
    .bind(lease, now + 60000, candidate.id, now, now).first<Job>();
  if (!job) return;
  try {
    const result: CompatibilityReport = await analyzePublicRepository(job.repository, env.fetchImpl);
    await env.db.prepare(`UPDATE public_diagnostic_jobs SET state = 'complete', result_json = ?, error = NULL, lease_id = NULL, lease_until = NULL
      WHERE id = ? AND lease_id = ? AND state = 'running' AND expires_at > ?`)
      .bind(JSON.stringify(result), job.id, lease, Date.now()).run();
  } catch (error) {
    const known = new Set(["repository_unavailable", "repository_too_large", "manifest_unavailable", "manifest_too_large", "upstream_rate_limited", "upstream_unavailable", "invalid_upstream_response"]);
    const reason = error instanceof Error && known.has(error.message) ? error.message : "diagnostic_unavailable";
    const retry = job.attempts < 2 && ["upstream_unavailable", "diagnostic_unavailable"].includes(reason);
    await env.db.prepare(`UPDATE public_diagnostic_jobs SET state = ?, error = ?, lease_id = NULL, lease_until = NULL
      WHERE id = ? AND lease_id = ? AND state = 'running'`)
      .bind(retry ? "queued" : "failed", reason, job.id, lease).run();
  }
}

export async function handleDiagnosticRequest(request: Request, env: DiagnosticEnv, waitUntil: (promise: Promise<unknown>) => void): Promise<Response> {
  if (!env.enabled || !env.rateSecret) return json({ error: "diagnostic_unavailable" }, 503);
  const path = new URL(request.url).pathname;
  try {
    if (request.method === "POST" && path === "/v1/public-analyzer/jobs") {
      // Only the edge-supplied address is trusted. Missing headers share one conservative bucket.
      const key = await clientBucket(env.rateSecret, request.headers.get("CF-Connecting-IP") ?? "unknown");
      if (!await takeRateLimit(env.db, `diagnostic:client:${key}`, 3, 3600)) return json({ error: "rate_limited" }, 429, "3600");
      let input: { repository?: unknown; consent?: unknown; consentVersion?: unknown };
      try { input = JSON.parse(await readBoundedText(request, 2048)); }
      catch (error) { return json({ error: error instanceof BodyLimitError ? "payload_too_large" : "invalid_request" }, error instanceof BodyLimitError ? 413 : 400); }
      const repository = parsePublicRepository(input?.repository);
      if (!repository || input?.consent !== true || input.consentVersion !== CONSENT_VERSION) return json({ error: "repository_and_explicit_consent_required" }, 400);
      if (!await takeRateLimit(env.db, "diagnostic:admissions", 8, 3600)) return json({ error: "service_busy" }, 429, "3600");
      const id = crypto.randomUUID();
      const token = crypto.randomUUID() + crypto.randomUUID();
      const now = Date.now();
      const row = await env.db.prepare(`INSERT INTO public_diagnostic_jobs
        (id, token_hash, repository, consent_version, state, created_at, expires_at)
        SELECT ?, ?, ?, ?, 'queued', ?, ? WHERE
          (SELECT COUNT(*) FROM public_diagnostic_jobs WHERE state IN ('queued','running') AND expires_at > ?) < 10 RETURNING id`)
        .bind(id, await hashOpaque(token), repository, CONSENT_VERSION, now, now + RESULT_LIFETIME_MS, now).first();
      if (!row) return json({ error: "service_busy" }, 429, "600");
      waitUntil(drainDiagnosticQueue(env).catch(() => undefined)); // cron recovers interruption/failure
      return json({ id, token, status: "queued", expiresAt: new Date(now + RESULT_LIFETIME_MS).toISOString(),
        notice: "Metadata diagnostic only. Keep this token private; it is required to read or delete the result." }, 202);
    }
    const match = path.match(/^\/v1\/public-analyzer\/jobs\/([a-f0-9-]{36})$/);
    if (match && (request.method === "GET" || request.method === "DELETE")) {
      const token = request.headers.get("Authorization")?.match(/^Bearer ([a-f0-9-]{72})$/)?.[1];
      if (!token) return json({ error: "not_found" }, 404);
      const tokenHash = await hashOpaque(token);
      const row = await env.db.prepare(`SELECT state, result_json, error, expires_at FROM public_diagnostic_jobs
        WHERE id = ? AND token_hash = ? AND expires_at > ?`).bind(match[1], tokenHash, Date.now())
        .first<{ state: string; result_json: string | null; error: string | null; expires_at: number }>();
      if (!row) return json({ error: "not_found" }, 404);
      if (request.method === "DELETE") {
        await env.db.prepare("DELETE FROM public_diagnostic_jobs WHERE id = ? AND token_hash = ?").bind(match[1], tokenHash).run();
        return json({ deleted: true });
      }
      if (!await takeRateLimit(env.db, `diagnostic:poll:${match[1]}`, 20, 60)) return json({ error: "rate_limited" }, 429, "60");
      return json({ status: row.state, result: row.result_json ? JSON.parse(row.result_json) : null, error: row.error,
        expiresAt: new Date(row.expires_at).toISOString() });
    }
    return json({ error: "not_found" }, 404);
  } catch { return json({ error: "diagnostic_unavailable" }, 503); }
}
