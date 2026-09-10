/** Best-effort, privacy-minimised conversion telemetry for GitHub App installs. */
export interface ConversionTelemetryEnv {
  POSTHOG_API_KEY?: string;
  POSTHOG_HOST?: string;
  SENTRY_DSN?: string;
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

export function reportInstallationFailure(env: ConversionTelemetryEnv, reason: string): Promise<void> {
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
