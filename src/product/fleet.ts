import type { ProductStore } from "./store.js";
import type { Repository } from "./types.js";
import type { FleetEvidenceReader, FleetWindowEvidence, ShadowReadBoundary } from "./shadow-read-boundary.js";
import type { EvidencePolicy, EvidencePolicyStore, PolicyRevision } from "./evidence-policy.js";

export type EvidenceFinding = "awaiting_workflow" | "no_observations" | "stale_observations" | "insufficient_predictions" | "insufficient_verification" | "no_failure_evidence" | "missed_failures";
export interface FleetRepository {
  repositoryId: string;
  repository: string;
  status: Repository["status"];
  current: FleetWindowEvidence;
  previous: FleetWindowEvidence;
  verificationPercent: number | null;
  selectivePercentChange: number | null;
  findings: EvidenceFinding[];
  assessment: "needs_attention" | "meets_reporting_policy";
}

export interface FleetReport {
  generatedAt: string;
  window: { start: string; end: string; previousStart: string };
  policy: PolicyRevision;
  repositories: FleetRepository[];
  totals: { repositories: number; needsAttention: number; predictions: number; verifiedPredictions: number; missedFailures: number; unavailable: number };
  unavailable: string[];
  notice: string;
}

export function assessEvidence(current: FleetWindowEvidence, policy: EvidencePolicy, workflowIdentified: boolean, now: Date): EvidenceFinding[] {
  const findings: EvidenceFinding[] = [];
  if (!workflowIdentified) findings.push("awaiting_workflow");
  if (current.missedFailures > 0) findings.push("missed_failures");
  if (current.predictions === 0) findings.push("no_observations");
  else if (!current.latestPredictionAt || !Number.isFinite(Date.parse(current.latestPredictionAt)) ||
    now.getTime() - Date.parse(current.latestPredictionAt) > policy.maxObservationAgeHours * 3600000) findings.push("stale_observations");
  if (current.predictions < policy.minimumPredictions) findings.push("insufficient_predictions");
  if (current.verifiedPredictions < policy.minimumVerifiedPredictions) findings.push("insufficient_verification");
  if (current.evaluableFailures < policy.minimumEvaluableFailures) findings.push("no_failure_evidence");
  return findings;
}

export interface FleetDeps {
  productStore: ProductStore;
  policies: EvidencePolicyStore;
  evidence: FleetEvidenceReader;
  shadow: Pick<ShadowReadBoundary, "getEvidenceWorkflowState">;
}

export async function getFleetForOrganization(deps: FleetDeps, userId: string, organizationId: string, now = new Date()): Promise<{ ok: true; data: FleetReport } | { ok: false; error: "unauthorized" }> {
  if (!await deps.productStore.isMember(organizationId, userId)) return { ok: false, error: "unauthorized" };
  const policy = await deps.policies.current(organizationId);
  const repositories = (await deps.productStore.listRepositories(organizationId)).filter((repo) => repo.status !== "removed");
  const width = policy.policy.windowDays * 86400000;
  const end = now.toISOString();
  const start = new Date(now.getTime() - width).toISOString();
  const previousStart = new Date(now.getTime() - 2 * width).toISOString();
  const rows: FleetRepository[] = [];
  const unavailable: string[] = [];
  // Four repositories at a time bounds D1 concurrency; independent repository failures stay visible.
  for (let offset = 0; offset < repositories.length; offset += 4) {
    await Promise.all(repositories.slice(offset, offset + 4).map(async (repo) => {
      try {
        const [current, previous, workflow] = await Promise.all([
          deps.evidence.summarize(repo.ownerName, start, end),
          deps.evidence.summarize(repo.ownerName, previousStart, start),
          deps.shadow.getEvidenceWorkflowState(repo.ownerName),
        ]);
        const findings = assessEvidence(current, policy.policy, workflow.state === "identified", now);
        rows.push({ repositoryId: repo.id, repository: repo.ownerName, status: repo.status, current, previous,
          verificationPercent: current.predictions ? current.verifiedPredictions / current.predictions * 100 : null,
          selectivePercentChange: current.predictions && previous.predictions
            ? (current.selective / current.predictions - previous.selective / previous.predictions) * 100 : null,
          findings, assessment: findings.length ? "needs_attention" : "meets_reporting_policy" });
      } catch {
        // A failed evidence read must never appear as zero activity or a passing policy.
        unavailable.push(repo.ownerName);
      }
    }));
  }
  rows.sort((a, b) => Number(b.findings.includes("missed_failures")) - Number(a.findings.includes("missed_failures")) ||
    Number(b.findings.length > 0) - Number(a.findings.length > 0) || a.repository.localeCompare(b.repository));
  unavailable.sort();
  return { ok: true, data: {
    generatedAt: end, window: { start, end, previousStart }, policy, repositories: rows, unavailable,
    totals: { repositories: repositories.length, needsAttention: rows.filter((r) => r.findings.length > 0).length,
      predictions: rows.reduce((sum, r) => sum + r.current.predictions, 0),
      verifiedPredictions: rows.reduce((sum, r) => sum + r.current.verifiedPredictions, 0),
      missedFailures: rows.reduce((sum, r) => sum + r.current.missedFailures, 0), unavailable: unavailable.length },
    notice: "Shadow evidence only. Meeting reporting policy does not authorize CI skipping or establish production savings. Verification counts distinct predictions; failure counts include verified prospective CI attempts. Totals exclude unavailable repositories.",
  } };
}
