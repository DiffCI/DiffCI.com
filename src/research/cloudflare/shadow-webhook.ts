/**
 * Stage 2 GitHub App webhook receiver (2026-08-21) - the event-driven observation source the
 * architecture doc designed ("github-app-webhook") and the App registration
 * (docs/github-app-registration.md) now makes real. Decision logic only, dependency-injected and
 * unit-testable in plain Node (tests/research/cloudflare/shadow-webhook.test.ts) - the same split as
 * shadow-cron.ts; validation-worker.ts wires the real signature secret, D1 store, and
 * poll/reconcile scheduling (ctx.waitUntil).
 *
 * Event handling is deliberately minimal and observe-only:
 * - Signature verification (github-app.ts verifyWebhookSignature) gates EVERYTHING, ping included -
 *   an unsigned/mis-signed delivery gets 401 and no processing. GitHub's HMAC is the only thing
 *   distinguishing a real delivery from an attacker-forged POST to a public URL.
 * - installation / installation_repositories: enroll the added repositories (source
 *   'github-app-webhook') and remember the installation id - the key that later lets the Worker mint
 *   per-installation read tokens (private-repo ground truth without a PAT). Uninstalls are logged
 *   loudly but change no state: per the Stage 2 spec, state transitions beyond
 *   VALIDATING->SHADOW_ACTIVE are human decisions.
 * - push to the DEFAULT branch: schedule an immediate shadow poll - the whole point of the webhook
 *   source is predicting closer to the push than a 10-minute cron tick can, which is what makes the
 *   prospectiveness evidence (prediction strictly before CI completion) strong. Non-default refs are
 *   acknowledged and ignored (the poll pipeline observes the default branch).
 * - workflow_run completed: schedule reconciliation for that repository - ground truth exactly when
 *   it exists, instead of waiting for the next cron sweep.
 * - pull_request: acknowledged, not yet processed (PR-delta shadow support is a designed-but-not-built
 *   follow-up; silently dropping the event category would hide that gap, so the response says so).
 * - Anything else: 200 "ignored" - GitHub sends many event types; a webhook that 4xxes unhandled
 *   events shows up as a sea of red in the App's delivery log for no reason.
 */

export interface ShadowWebhookDeps {
  /** verifyWebhookSignature bound to the configured secret. */
  verifySignature(rawBody: string, signatureHeader: string | null): Promise<boolean>;
  /** Idempotent enrollment, source 'github-app-webhook'. */
  ensureRepository(repository: string, language: string): Promise<void>;
  setInstallationId(repository: string, installationId: string): Promise<void>;
  /** Fire-and-forget (the Worker uses ctx.waitUntil) - failures must be logged by the implementation,
   * never thrown back into webhook handling: GitHub only needs the 2xx acknowledgment. */
  schedulePoll(repository: string): void;
  scheduleReconcile(repository: string): void;
  /**
   * EXTERNAL_ENGINE_BRIDGE_01. Fire-and-forget, same rule as schedulePoll - triggers the independent
   * ci:reproduce engine (src/ci-inference/) inside the same enrolled-repository Sandbox path, alongside
   * the dependency-graph prediction schedulePoll already starts. Optional so every existing caller and
   * fixture (in particular tests/research/cloudflare/shadow-webhook.test.ts's makeDeps()) is unaffected -
   * an environment that hasn't wired this dep simply doesn't get the extra trigger, never an error.
   */
  scheduleCiReproductionBridge?(repository: string): void;
  log(message: string): void;
}

export interface WebhookOutcome {
  status: number;
  body: Record<string, unknown>;
}

const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;

function ok(action: string, extra: Record<string, unknown> = {}): WebhookOutcome {
  return { status: 200, body: { ok: true, action, ...extra } };
}

export async function handleShadowWebhook(
  eventName: string | null,
  signatureHeader: string | null,
  rawBody: string,
  deps: ShadowWebhookDeps,
): Promise<WebhookOutcome> {
  if (!(await deps.verifySignature(rawBody, signatureHeader))) {
    return { status: 401, body: { ok: false, error: "invalid-signature" } };
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { ok: false, error: "invalid-json" } };
  }

  switch (eventName) {
    case "ping":
      return ok("pong");

    case "installation": {
      const installationId = String(payload?.installation?.id ?? "");
      const action = String(payload?.action ?? "");
      if (action === "deleted" || action === "suspend") {
        deps.log(`shadow-webhook: App installation ${installationId} ${action} - repositories keep their state (human decision per spec), but token minting for them will fail until reinstalled`);
        return ok(`installation-${action}-acknowledged`);
      }
      const repos: string[] = (payload?.repositories ?? []).map((r: any) => String(r?.full_name ?? "")).filter((r: string) => REPOSITORY_PATTERN.test(r));
      for (const repository of repos) {
        await deps.ensureRepository(repository, "typescript");
        if (installationId) await deps.setInstallationId(repository, installationId);
      }
      deps.log(`shadow-webhook: installation ${action} - enrolled ${repos.length} repository(ies): ${repos.join(", ")}`);
      return ok("installation-enrolled", { repositories: repos });
    }

    case "installation_repositories": {
      const installationId = String(payload?.installation?.id ?? "");
      const added: string[] = (payload?.repositories_added ?? []).map((r: any) => String(r?.full_name ?? "")).filter((r: string) => REPOSITORY_PATTERN.test(r));
      const removed: string[] = (payload?.repositories_removed ?? []).map((r: any) => String(r?.full_name ?? "")).filter(Boolean);
      for (const repository of added) {
        await deps.ensureRepository(repository, "typescript");
        if (installationId) await deps.setInstallationId(repository, installationId);
      }
      if (removed.length > 0) {
        deps.log(`shadow-webhook: repositories removed from installation ${installationId} (state unchanged, human decision per spec): ${removed.join(", ")}`);
      }
      return ok("installation-repositories-updated", { added, removed });
    }

    case "push": {
      const repository = String(payload?.repository?.full_name ?? "");
      if (!REPOSITORY_PATTERN.test(repository)) return { status: 400, body: { ok: false, error: "invalid-repository" } };
      const ref = String(payload?.ref ?? "");
      const defaultBranch = String(payload?.repository?.default_branch ?? "");
      if (!defaultBranch || ref !== `refs/heads/${defaultBranch}`) {
        return ok("push-non-default-branch-ignored", { repository, ref });
      }
      await deps.ensureRepository(repository, "typescript");
      const installationId = String(payload?.installation?.id ?? "");
      if (installationId) await deps.setInstallationId(repository, installationId);
      deps.schedulePoll(repository);
      // Independent of the poll above: same push, same enrolled repository, a SEPARATE analysis engine.
      // Never blocks or replaces schedulePoll, and its absence from the response body when unwired keeps
      // this byte-for-byte compatible with every caller that doesn't yet supply it.
      deps.scheduleCiReproductionBridge?.(repository);
      return ok("poll-scheduled", { repository });
    }

    case "workflow_run": {
      const repository = String(payload?.repository?.full_name ?? "");
      if (!REPOSITORY_PATTERN.test(repository)) return { status: 400, body: { ok: false, error: "invalid-repository" } };
      if (String(payload?.action ?? "") !== "completed") {
        return ok("workflow-run-not-completed-ignored", { repository });
      }
      deps.scheduleReconcile(repository);
      return ok("reconcile-scheduled", { repository });
    }

    case "pull_request":
      // Designed-but-not-built: PR-delta shadow predictions. Acknowledged explicitly so the gap is
      // visible in the delivery log rather than silently swallowed as a generic "ignored".
      return ok("pull-request-not-yet-supported");

    default:
      return ok("ignored", { event: eventName ?? "unknown" });
  }
}
