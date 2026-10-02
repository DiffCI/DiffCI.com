import assert from "node:assert/strict";
import { it } from "node:test";
import { freshProductDb, makeD1 } from "../helpers/product-db.js";
import { analyzePublicRepository, parsePublicRepository } from "../../src/diagnostics/analyze.js";
import { handleDiagnosticRequest, drainDiagnosticQueue, CONSENT_VERSION } from "../../src/diagnostics/service.js";
import { readBoundedText, BodyLimitError, takeRateLimit, clientBucket } from "../../src/hosted/limits.js";

const sha = "a".repeat(40);
function upstream(seen: string[] = []): typeof fetch {
  return (async (url, init) => {
    seen.push(String(url));
    assert.equal(init?.redirect, "manual");
    assert.equal(new Headers(init?.headers).has("Authorization"), false);
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/commits/main")) return Response.json({ sha });
    if (path.endsWith("/contents")) return Response.json([{ name: "package.json", type: "file" }, { name: "tsconfig.json", type: "file" }]);
    if (path.endsWith("/contents/package.json")) {
      const content = JSON.stringify({ scripts: { test: "vitest && secret-untrusted-command" } });
      return Response.json({ type: "file", encoding: "base64", size: content.length, content: btoa(content) });
    }
    return Response.json({ private: false, visibility: "public", default_branch: "main" });
  }) as typeof fetch;
}
function fixture(fetchImpl = upstream()) {
  const db = freshProductDb();
  const env = { db: makeD1(db), enabled: true, rateSecret: "test-only", fetchImpl };
  const pending: Promise<unknown>[] = [];
  const call = (method: string, suffix = "", token?: string, body?: unknown) => handleDiagnosticRequest(new Request(`https://test/v1/public-analyzer/jobs${suffix}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "CF-Connecting-IP": "192.0.2.1" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), env, (p) => { pending.push(p); });
  const submit = () => call("POST", "", undefined, { repository: "acme/project", consent: true, consentVersion: CONSENT_VERSION });
  return { db, env, pending, call, submit };
}

it("accepts only canonical GitHub repository inputs, never arbitrary fetch targets", () => {
  assert.equal(parsePublicRepository("https://github.com/acme/project/"), "acme/project");
  for (const input of ["http://localhost/a", "https://github.com.evil/a/b", "https://github.com/a/b?x=y", "a/..", "a/b/tree/main", "a/%2e%2e", null]) assert.equal(parsePublicRepository(input), null);
});
it("pins manifest reads, never exposes commands, and labels evidence limits", async () => {
  const seen: string[] = [];
  const report = await analyzePublicRepository("acme/project", upstream(seen));
  assert.equal(report.headSha, sha);
  assert.equal(report.status, "candidate");
  assert.equal(seen.length, 4);
  assert.ok(seen.slice(2).every((url) => new URL(url).searchParams.get("ref") === sha));
  assert.ok(!JSON.stringify(report).includes("secret-untrusted-command"));
  assert.match(report.unknowns.join(" "), /unmeasured/);
});
it("refuses private or unknown privacy before reading manifests", async () => {
  for (const metadata of [{ private: true }, { default_branch: "main" }]) {
    let calls = 0;
    await assert.rejects(analyzePublicRepository("acme/project", (async () => { calls++; return Response.json(metadata); }) as typeof fetch), /repository_unavailable/);
    assert.equal(calls, 1);
  }
});
it("uses the Workers-supported manual mode and refuses redirects without fetching their target", async () => {
  let calls = 0;
  await assert.rejects(analyzePublicRepository("acme/project", (async (_url, init) => {
    calls++;
    assert.equal(init?.redirect, "manual");
    return new Response(null, { status: 302, headers: { Location: "https://example.invalid/private" } });
  }) as typeof fetch), /repository_unavailable/);
  assert.equal(calls, 1);
});
it("caps streamed bytes without Content-Length and decodes split UTF-8", async () => {
  const bytes = new TextEncoder().encode("éé");
  const response = () => new Response(new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, 1)); c.enqueue(bytes.slice(1)); c.close(); } }));
  assert.equal(await readBoundedText(response(), 4), "éé");
  await assert.rejects(readBoundedText(response(), 3), BodyLimitError);
});
it("shared rate counters admit exactly the limit under concurrency and reset by window", async () => {
  const db = freshProductDb();
  const d1 = makeD1(db);
  const results = await Promise.all(Array.from({ length: 20 }, () => takeRateLimit(d1, "test", 3, 60, 1000)));
  assert.equal(results.filter(Boolean).length, 3);
  assert.equal(await takeRateLimit(d1, "test", 3, 60, 61000), true);
  assert.notEqual(await clientBucket("secret", "ip", 0), await clientBucket("secret", "ip", 86400000));
  db.close();
});
it("requires explicit versioned consent and configuration before admission", async () => {
  const f = fixture();
  assert.equal((await f.call("POST", "", undefined, { repository: "acme/project", consent: true })).status, 400);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM public_diagnostic_jobs").get()!.n, 0);
  f.env.enabled = false;
  assert.equal((await f.submit()).status, 503);
  f.db.close();
});
it("completes bounded jobs with private tokens, no-store access and deletion", async () => {
  const f = fixture();
  const response = await f.submit();
  assert.equal(response.status, 202);
  const { id, token } = await response.json() as { id: string; token: string };
  await Promise.all(f.pending);
  const row = f.db.prepare("SELECT * FROM public_diagnostic_jobs").get()!;
  assert.notEqual(row.token_hash, token);
  assert.equal(row.consent_version, CONSENT_VERSION);
  assert.equal((await f.call("GET", `/${id}`)).status, 404);
  assert.equal((await f.call("GET", `/${id}`, crypto.randomUUID() + crypto.randomUUID())).status, 404);
  const read = await f.call("GET", `/${id}`, token);
  assert.equal(read.headers.get("Cache-Control"), "no-store");
  assert.equal((await read.json() as { status: string }).status, "complete");
  assert.equal((await f.call("DELETE", `/${id}`, token)).status, 200);
  assert.equal((await f.call("GET", `/${id}`, token)).status, 404);
  f.db.close();
});
it("deleted jobs cannot be resurrected by in-flight completion", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const fake = upstream();
  const f = fixture((async (...args) => { await gate; return fake(...args); }) as typeof fetch);
  const { id, token } = await (await f.submit()).json() as { id: string; token: string };
  await f.call("DELETE", `/${id}`, token);
  release();
  await Promise.all(f.pending);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM public_diagnostic_jobs").get()!.n, 0);
  f.db.close();
});
it("recovers expired leases, caps attempts and purges expired jobs even when disabled", async () => {
  const f = fixture((async () => new Response("unavailable", { status: 500 })) as typeof fetch);
  const { id, token } = await (await f.submit()).json() as { id: string; token: string };
  await Promise.all(f.pending);
  f.db.prepare("UPDATE public_diagnostic_jobs SET state='running', lease_until=0 WHERE id=?").run(id);
  await drainDiagnosticQueue(f.env);
  const row = f.db.prepare("SELECT state, attempts FROM public_diagnostic_jobs").get()!;
  assert.equal(row.state, "failed");
  assert.equal(row.attempts, 2);
  f.db.prepare("UPDATE public_diagnostic_jobs SET expires_at=0").run();
  assert.equal((await f.call("GET", `/${id}`, token)).status, 404);
  f.env.enabled = false;
  await drainDiagnosticQueue(f.env);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM public_diagnostic_jobs").get()!.n, 0);
  f.db.close();
});
