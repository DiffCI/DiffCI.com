import { signAppJwt } from '../../shadow/github-app.js';

export interface AnalyticsDB {
  prepare(sql: string): { bind(...values: unknown[]): {
    run(): Promise<unknown>;
    all<T>(): Promise<{ results: T[] }>;
    first<T>(): Promise<T | null>;
  } };
}
export interface AnalyticsEnv {
  RESEARCH_DB: AnalyticsDB;
  POSTHOG_API_KEY?: string;
  POSTHOG_HOST?: string;
  POSTHOG_IDENTITY_SALT?: string;
  SHADOW_GITHUB_APP_ID?: string;
  SHADOW_GITHUB_APP_PRIVATE_KEY?: string;
}
type Props = Record<string, string | number | boolean | null>;
export function internalAccount(login: unknown): boolean {
  return typeof login === 'string' && login.toLowerCase() === 'adityankale190895';
}
export async function analyticsIdentity(env: AnalyticsEnv, value: string): Promise<string> {
  if (!env.POSTHOG_IDENTITY_SALT) throw new Error('POSTHOG_IDENTITY_SALT missing');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.POSTHOG_IDENTITY_SALT), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`diffci-analytics-v1:${value}`));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export async function enqueueAnalytics(env: AnalyticsEnv, key: string, event: string, installationId: string, properties: Props, timestamp = new Date().toISOString()): Promise<void> {
  if (!env.POSTHOG_API_KEY) return;
  const id = await analyticsIdentity(env, `installation:${installationId}`);
  const eventKey = await analyticsIdentity(env, `event:${key}`);
  const payload = { uuid: crypto.randomUUID(), event, timestamp,
    properties: { ...properties, distinct_id: `installation:${id}`, installation_key: id,
      product: 'diffci', app: 'shadow', environment: 'production', schema_version: 1,
      $process_person_profile: false, $geoip_disable: true } };
  // The first receipt fixes UUID, timestamp, and payload for every retry.
  await env.RESEARCH_DB.prepare('INSERT OR IGNORE INTO shadow_analytics_outbox (event_key, payload, created_at) VALUES (?, ?, ?)')
    .bind(eventKey, JSON.stringify(payload), timestamp).run();
}

/** Call ONLY after signature verification and successful webhook handling. */
export async function recordInstallationWebhook(env: AnalyticsEnv, event: string | null, raw: string, deliveryId: string | null): Promise<void> {
  if (!env.POSTHOG_API_KEY || (event !== 'installation' && event !== 'installation_repositories')) return;
  const p = JSON.parse(raw);
  const installationId = String(p.installation?.id ?? '');
  if (!/^\d+$/.test(installationId) || !deliveryId) throw new Error('installation analytics requires installation and delivery identifiers');
  const action = String(p.action ?? '');
  const names: Record<string, string> = { created: 'github_app_installation_created', deleted: 'github_app_installation_deleted', suspend: 'github_app_installation_suspended', unsuspend: 'github_app_installation_unsuspended', new_permissions_accepted: 'github_app_permissions_accepted' };
  const name = event === 'installation_repositories' ? 'github_app_repositories_changed' : names[action];
  if (!name) return;
  const count = (v: unknown) => Array.isArray(v) ? v.length : 0;
  await enqueueAnalytics(env, `github:${deliveryId}`, name, installationId, {
    is_internal: internalAccount(p.installation?.account?.login), is_test: false,
    repository_count: count(p.repositories), repositories_added: count(p.repositories_added),
    repositories_removed: count(p.repositories_removed), action,
    source: 'verified_github_webhook',
  });
}

export async function flushAnalytics(env: AnalyticsEnv): Promise<{ sent: number; pending: number; error?: string }> {
  if (!env.POSTHOG_API_KEY) return { sent: 0, pending: 0, error: 'not configured' };
  const { results } = await env.RESEARCH_DB.prepare('SELECT event_key, payload FROM shadow_analytics_outbox WHERE sent_at IS NULL ORDER BY created_at LIMIT 50').bind().all<{event_key:string; payload:string}>();
  let error: string | undefined;
  if (results.length) {
    try {
      const r = await fetch(`${env.POSTHOG_HOST ?? 'https://us.i.posthog.com'}/batch/`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10000),
        body: JSON.stringify({ api_key: env.POSTHOG_API_KEY, batch: results.map(row => JSON.parse(row.payload)) }),
      });
      if (!r.ok) throw new Error(`PostHog HTTP ${r.status}`);
      const body = await r.json() as { status?: number | string };
      if (body.status !== 1 && body.status !== 'Ok') throw new Error('PostHog did not acknowledge batch');
      for (const row of results) await env.RESEARCH_DB.prepare('UPDATE shadow_analytics_outbox SET sent_at = ?, attempts = attempts + 1, last_error = NULL WHERE event_key = ?').bind(new Date().toISOString(), row.event_key).run();
    } catch (e) {
      error = e instanceof Error ? e.message : 'delivery failed';
      for (const row of results) await env.RESEARCH_DB.prepare('UPDATE shadow_analytics_outbox SET attempts = attempts + 1, last_error = ? WHERE event_key = ?').bind(error, row.event_key).run();
      console.error(`shadow-analytics: ${error}; retained for retry`);
    }
  }
  const pending = await env.RESEARCH_DB.prepare('SELECT COUNT(*) AS n FROM shadow_analytics_outbox WHERE sent_at IS NULL').bind().first<{n:number}>();
  return { sent: error ? 0 : results.length, pending: pending?.n ?? 0, ...(error ? { error } : {}) };
}

/** GitHub's installation inventory includes installations with zero selected/enrolled repositories. */
export async function syncAnalytics(env: AnalyticsEnv): Promise<unknown> {
  if (!env.POSTHOG_API_KEY) return { configured: false };
  if (!env.SHADOW_GITHUB_APP_ID || !env.SHADOW_GITHUB_APP_PRIVATE_KEY) throw new Error('GitHub App credentials missing');
  const jwt = await signAppJwt({ appId: env.SHADOW_GITHUB_APP_ID, privateKeyPkcs8Pem: env.SHADOW_GITHUB_APP_PRIVATE_KEY });
  type Install = { id: number; suspended_at: string | null; account: { login: string }; created_at: string };
  const installations: Install[] = [];
  for (let page = 1; ; page++) {
    const r = await fetch(`https://api.github.com/app/installations?per_page=100&page=${page}`, { headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'User-Agent': 'diffci-shadow' }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`GitHub inventory HTTP ${r.status}`);
    const batch = await r.json() as Install[];
    installations.push(...batch);
    if (batch.length < 100) break;
    if (page >= 100) throw new Error('GitHub inventory exceeded pagination bound; no partial snapshot emitted');
  }
  const now = new Date().toISOString();
  const hour = now.slice(0, 13);
  for (const i of installations) {
    const id = String(i.id);
    const { results: repositories } = await env.RESEARCH_DB.prepare("SELECT repository FROM shadow_repositories WHERE installation_id = ? AND state != 'REMOVED'").bind(id).all<{repository:string}>();
    const props = { is_internal: internalAccount(i.account.login), is_test: false, suspended: !!i.suspended_at, observed_repository_count: repositories.length, source: 'github_inventory' };
    // Snapshot is intentionally NOT an installation-created event: historical installs are not new conversions.
    await enqueueAnalytics(env, `inventory:${id}:${hour}`, 'github_app_installation_snapshot', id, props, now);
    for (const repo of repositories) {
      const first = await env.RESEARCH_DB.prepare('SELECT MIN(created_at) AS first_at FROM shadow_predictions WHERE repository = ?').bind(repo.repository).first<{first_at:string|null}>();
      if (!first?.first_at) continue;
      const repositoryKey = await analyticsIdentity(env, `repository:${repo.repository}`);
      await enqueueAnalytics(env, `first-prediction:${id}:${repositoryKey}`, 'shadow_first_prediction_recorded', id, {
        is_internal: props.is_internal, is_test: false, repository_key: repositoryKey,
        is_backfill: first.first_at < '2026-09-10T00:00:00.000Z', source: 'prediction_store',
      }, first.first_at);
    }
  }
  await enqueueAnalytics(env, `inventory-total:${hour}`, 'github_app_inventory_snapshot', 'inventory', {
    is_internal: false, is_test: false, source: 'github_inventory',
    total_installations: installations.length,
    active_installations: installations.filter(i => !i.suspended_at).length,
    external_installations: installations.filter(i => !internalAccount(i.account.login)).length,
    active_external_installations: installations.filter(i => !i.suspended_at && !internalAccount(i.account.login)).length,
  }, now);
  return { configured: true, installations: installations.length, ...await flushAnalytics(env) };
}

export async function recordReportServed(env: AnalyticsEnv, repository: string, days: number): Promise<void> {
  const row = await env.RESEARCH_DB.prepare('SELECT installation_id FROM shadow_repositories WHERE repository = ?').bind(repository).first<{installation_id:string|null}>();
  if (!row?.installation_id) return;
  await enqueueAnalytics(env, `report:${crypto.randomUUID()}`, 'shadow_report_served', row.installation_id, {
    repository_key: await analyticsIdentity(env, `repository:${repository}`), days,
    is_internal: internalAccount(repository.split('/')[0]), is_test: false,
    source: 'report_endpoint', human_read_confirmed: false,
  });
  await flushAnalytics(env);
}
