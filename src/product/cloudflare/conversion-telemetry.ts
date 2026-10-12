/** Best-effort, privacy-minimised conversion telemetry for GitHub App installs. */
export interface ConversionTelemetryEnv {
  POSTHOG_API_KEY?: string;
  POSTHOG_HOST?: string;
  SENTRY_DSN?: string;
}

export type WebhookFailureSource = "product" | "research";

const UNAUTHENTICATED_WEBHOOK_REJECTION_REASONS = new Set(["bad_signature", "invalid-signature"]);
const UNAUTHENTICATED_WEBHOOK_LOG_INTERVAL_MS = 5 * 60 * 1000;
const lastUnauthenticatedWebhookLog = new Map<string, number>();

/**
 * An invalid signature is unauthenticated Internet input, not an application
 * failure. Keep the HTTP rejection path observable without allowing it to
 * consume one Sentry event per request. This is deliberately a best-effort,
 * per-isolate log limiter: it is never part of an authorization decision.
 */
export function isUnauthenticatedWebhookRejection(reason: string): boolean {
  return UNAUTHENTICATED_WEBHOOK_REJECTION_REASONS.has(reason);
}

function logUnauthenticatedWebhookRejection(source: WebhookFailureSource, reason: string): void {
  const key = `${source}:${reason}`;
  const now = Date.now();
  const previous = lastUnauthenticatedWebhookLog.get(key);
  if (previous !== undefined && now - previous < UNAUTHENTICATED_WEBHOOK_LOG_INTERVAL_MS) return;
  lastUnauthenticatedWebhookLog.set(key, now);
  // Deliberately low-cardinality: never log payloads, signatures, delivery IDs, IPs, or user agents.
  console.warn(JSON.stringify({
    event: "github_installation_webhook.unauthenticated_rejection_sampled",
    source,
    reason,
    sample_interval_ms: UNAUTHENTICATED_WEBHOOK_LOG_INTERVAL_MS,
  }));
}

export async function reportOptInCliUsage(env: ConversionTelemetryEnv, command: string, outcome: string, version: string): Promise<void> {
  if (!env.POSTHOG_API_KEY) return;
  const response = await fetch(`${env.POSTHOG_HOST ?? "https://us.i.posthog.com"}/capture/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: env.POSTHOG_API_KEY,
      event: "cli_usage_opt_in",
      properties: {
        distinct_id: "diffci-cli-opt-in",
        command,
        outcome,
        version,
        $process_person_profile: false,
        $geoip_disable: true,
      },
    }),
  });
  if (!response.ok) throw new Error(`PostHog capture failed with HTTP ${response.status}`);
}

export function reportInstallationCreated(env: ConversionTelemetryEnv, repositoryCount: number): Promise<void> {
  const jobs: Promise<unknown>[] = [];
  if (env.POSTHOG_API_KEY) {
    jobs.push(fetch(`${env.POSTHOG_HOST ?? "https://us.i.posthog.com"}/capture/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: env.POSTHOG_API_KEY,
        event: "github_app_installation_created",
        // Aggregate conversion measurement only: never send the installer, account, repo, or delivery id.
        properties: { distinct_id: "github-app-installations", repository_count: repositoryCount },
      }),
    }));
  }
  if (env.SENTRY_DSN) jobs.push(reportSentryMessage(env.SENTRY_DSN, "github_app_installation_created", "info"));
  return Promise.allSettled(jobs).then(() => undefined);
}

export function reportInstallationFailure(env: ConversionTelemetryEnv, reason: string, source: WebhookFailureSource = "product"): Promise<void> {
  if (isUnauthenticatedWebhookRejection(reason)) {
    logUnauthenticatedWebhookRejection(source, reason);
    return Promise.resolve();
  }
  if (!env.SENTRY_DSN) return Promise.resolve();
  return reportSentryMessage(env.SENTRY_DSN, `github_installation_webhook_failed:${reason}`, "error");
}

async function reportSentryMessage(dsn: string, message: string, level: "info" | "error"): Promise<void> {
  const url = new URL(dsn);
  const projectId = url.pathname.slice(1);
  if (!url.username || !projectId) return;
  const endpoint = `${url.protocol}//${url.host}/api/${projectId}/envelope/`;
  const eventId = crypto.randomUUID().replaceAll("-", "");
  const envelope = `${JSON.stringify({ sent_at: new Date().toISOString() })}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify({ event_id: eventId, level, message, platform: "javascript", tags: { component: "github-installation-webhook" } })}`;
  await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/x-sentry-envelope", "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${url.username}` }, body: envelope });
}
