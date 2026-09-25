import type { Repository } from "./types.js";
import type { ObservationRecord } from "../ingest/types.js";
import type { IngestTokenRecord } from "../ingest/token.js";

export interface OnboardingStatus {
  state: "inactive" | "unavailable" | "needs_token" | "awaiting_report" | "needs_attention" | "observing";
  title: string;
  nextStep: string;
  latestReceivedAt?: string;
}

/** Describes the observer upload path only, never enforcement or savings readiness. */
export function buildOnboardingStatus(input: {
  repository: Repository;
  tokens: readonly IngestTokenRecord[];
  observations: readonly ObservationRecord[];
  evidenceAvailable?: boolean;
  now?: Date;
}): OnboardingStatus {
  const { repository } = input;
  if (repository.status !== "active") return {
    state: "inactive", title: "Repository is not active",
    nextStep: "Check the GitHub App installation and repository access before setting up observation.",
  };
  if (input.evidenceAvailable === false) return {
    state: "unavailable", title: "Setup status is unavailable",
    nextStep: "Reload to retry reading credentials and reports. This does not mean your setup is incomplete.",
  };
  const belongs = (row: { organizationId: string; repositoryId: string }) =>
    row.organizationId === repository.organizationId && row.repositoryId === repository.id;
  const latest = input.observations.filter(belongs).sort((a, b) =>
    b.receivedAt.localeCompare(a.receivedAt) || b.id.localeCompare(a.id))[0];
  const now = (input.now ?? new Date()).getTime();
  if (!input.tokens.some(token => belongs(token) && !token.revokedAt &&
    (!token.expiresAt || Date.parse(token.expiresAt) > now))) return {
    state: "needs_token", title: "Create a repository credential",
    nextStep: "Create an ingest token below and save it as the GitHub Actions secret. A previously received report does not confirm that uploads still work.",
  };
  if (!latest) return {
    state: "awaiting_report", title: "Waiting for the first report",
    nextStep: "Save the secret, commit the workflow below, and trigger a push or pull request. Check the Action log if no report arrives, then reload this page.",
  };
  const latestReceivedAt = latest.receivedAt;
  if (latest.status !== "OBSERVED" || latest.stage !== "complete") return {
    state: "needs_attention", title: "Latest analysis did not complete",
    nextStep: "Open the latest observation below and inspect the Action log. Resolve the refusal or error, then rerun the observation job.", latestReceivedAt,
  };
  if (!latest.worktreeUnchanged || latest.blockingWorkflowFindings > 0 || !latest.identityVerified) return {
    state: "needs_attention", title: "Review the latest report",
    nextStep: "Confirm repository identity and run diffci verify-workflow. Resolve workflow findings and checkout changes before relying on this report.", latestReceivedAt,
  };
  return {
    state: "observing", title: "Observation received",
    nextStep: "Review the report below and collect observations across more changes. This confirms a completed upload, not ongoing freshness, production savings, or permission to skip required CI.", latestReceivedAt,
  };
}
