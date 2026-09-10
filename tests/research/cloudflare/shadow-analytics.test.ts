import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSync } from 'node:crypto';
import { analyticsIdentity, enqueueAnalytics, recordInstallationWebhook, flushAnalytics, syncAnalytics, type AnalyticsDB, type AnalyticsEnv } from '../../../src/research/cloudflare/shadow-analytics.js';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync('src/research/cloudflare/schema-migration-2026-09-10-posthog.sql', 'utf8'));
  db.exec('CREATE TABLE shadow_repositories(repository TEXT, installation_id TEXT, state TEXT); CREATE TABLE shadow_predictions(repository TEXT, created_at TEXT)');
  const adapter: AnalyticsDB = { prepare: sql => ({ bind: (...values: unknown[]) => ({
    run: async () => db.prepare(sql).run(...values as never[]),
    all: async <T>() => ({ results: db.prepare(sql).all(...values as never[]) as T[] }),
    first: async <T>() => (db.prepare(sql).get(...values as never[]) as T | undefined) ?? null,
  }) }) };
  const env: AnalyticsEnv = { RESEARCH_DB: adapter, POSTHOG_API_KEY: 'test-token', POSTHOG_IDENTITY_SALT: 'test-salt' };
  return { db, env };
}

test('webhook retries preserve one payload and pseudonymous identity; raw account and repository never leave the boundary', async () => {
  const { db, env } = fixture();
  const raw = JSON.stringify({ action: 'created', installation: { id: 123, account: { login: 'private-customer' } }, repositories: [{ full_name: 'private-customer/secret-repo' }] });
  await recordInstallationWebhook(env, 'installation', raw, 'delivery-1');
  const before = db.prepare('SELECT payload FROM shadow_analytics_outbox').get()!.payload;
  await recordInstallationWebhook(env, 'installation', raw, 'delivery-1');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shadow_analytics_outbox').get()!.n, 1);
  assert.equal(db.prepare('SELECT payload FROM shadow_analytics_outbox').get()!.payload, before);
  const payload = JSON.parse(String(before));
  assert.equal(payload.event, 'github_app_installation_created');
  assert.equal(payload.properties.repository_count, 1);
  assert.equal(payload.properties.is_internal, false);
  assert.equal(String(before).includes('private-customer'), false);
  assert.equal(String(before).includes('delivery-1'), false);
  assert.notEqual(await analyticsIdentity(env, 'installation:123'), await analyticsIdentity(env, 'installation:124'));
  db.close();
});

test('unsuspend, removal, and repository updates never become new installs', async () => {
  const { db, env } = fixture();
  for (const action of ['unsuspend', 'suspend', 'deleted']) await recordInstallationWebhook(env, 'installation', JSON.stringify({action, installation:{id:1,account:{login:'adityankale190895'}}}), action);
  await recordInstallationWebhook(env, 'installation_repositories', JSON.stringify({action:'removed', installation:{id:1}, repositories_removed:[{id:2}]}), 'repos');
  const names = db.prepare('SELECT payload FROM shadow_analytics_outbox').all().map(r => JSON.parse(String(r.payload)).event);
  assert.deepEqual(names, ['github_app_installation_unsuspended', 'github_app_installation_suspended', 'github_app_installation_deleted', 'github_app_repositories_changed']);
  db.close();
});

test('failed delivery remains pending and retry sends identical UUID and timestamp', async () => {
  const { db, env } = fixture();
  await enqueueAnalytics(env, 'one', 'test', '1', {is_test:true});
  const bodies: string[] = [];
  const stub = mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => { bodies.push(String(init.body)); return new Response('unavailable', {status:503}); });
  try {
    assert.equal((await flushAnalytics(env)).pending, 1);
    assert.equal(db.prepare('SELECT sent_at FROM shadow_analytics_outbox').get()!.sent_at, null);
    stub.mock.mockImplementation(async (_url: unknown, init: RequestInit) => { bodies.push(String(init.body)); return Response.json({status:1}); });
    assert.equal((await flushAnalytics(env)).pending, 0);
    assert.equal(bodies[0], bodies[1]);
    assert.equal((await flushAnalytics(env)).sent, 0);
  } finally { stub.mock.restore(); db.close(); }
});

test('GitHub snapshot includes zero-repository installs, distinguishes internal accounts, and backfills predictions without fabricating installs', async () => {
  const { db, env } = fixture();
  const { privateKey } = generateKeyPairSync('rsa', {modulusLength:2048});
  env.SHADOW_GITHUB_APP_ID = '1';
  env.SHADOW_GITHUB_APP_PRIVATE_KEY = privateKey.export({type:'pkcs8',format:'pem'}).toString();
  db.exec("INSERT INTO shadow_repositories VALUES ('owner/repo','1','SHADOW_ACTIVE'); INSERT INTO shadow_predictions VALUES ('owner/repo','2026-09-01T00:00:00.000Z')");
  const stub = mock.method(globalThis, 'fetch', async (url: unknown) => String(url).includes('api.github.com')
    ? Response.json([{id:1,account:{login:'adityankale190895'},suspended_at:null},{id:2,account:{login:'customer'},suspended_at:'2026-09-09'}])
    : Response.json({status:1}));
  try {
    await syncAnalytics(env);
    await syncAnalytics(env);
    const events = db.prepare('SELECT payload FROM shadow_analytics_outbox').all().map(r => JSON.parse(String(r.payload)));
    assert.equal(events.length, 4);
    const total = events.find(e => e.event === 'github_app_inventory_snapshot').properties;
    assert.equal(total.total_installations, 2);
    assert.equal(total.active_installations, 1);
    assert.equal(total.external_installations, 1);
    assert.equal(total.active_external_installations, 0);
    assert.equal(events.find(e => e.event === 'shadow_first_prediction_recorded').properties.is_backfill, true);
    assert.equal(events.some(e => e.event === 'github_app_installation_created'), false);
  } finally { stub.mock.restore(); db.close(); }
});

test('unrelated events are ignored and missing delivery identifiers are rejected', async () => {
  const { db, env } = fixture();
  await recordInstallationWebhook(env, 'push', '{}', null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shadow_analytics_outbox').get()!.n, 0);
  await assert.rejects(recordInstallationWebhook(env, 'installation', '{"installation":{"id":1},"action":"created"}', null));
  db.close();
});
