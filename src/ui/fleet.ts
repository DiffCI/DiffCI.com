import type { FleetReport, EvidenceFinding } from "../product/fleet.js";
import type { PolicyRevision } from "../product/evidence-policy.js";
import { html, type SafeHtml } from "./render.js";

const FINDINGS: Record<EvidenceFinding, string> = {
  awaiting_workflow: "Identify the CI evidence workflow",
  no_observations: "No observations in this window",
  stale_observations: "Observations are stale",
  insufficient_predictions: "More observations needed",
  insufficient_verification: "More verified CI outcomes needed",
  no_failure_evidence: "More evaluable failure evidence needed",
  missed_failures: "Review failures missed by selection",
};

export interface FleetPanelData {
  report: FleetReport;
  canEditPolicy: boolean;
  history: PolicyRevision[];
}

export function renderFleetPanel(organizationId: string, data?: FleetPanelData): SafeHtml {
  if (!data) return html`<h2>Fleet evidence</h2><p class="notice">Fleet evidence is unavailable. No policy assessment can be made right now.</p>`;
  const { report, history, canEditPolicy } = data;
  const policy = report.policy.policy;
  const fields = [
    ["windowDays", "Observation window (days)", 1, 90],
    ["maxObservationAgeHours", "Maximum observation age (hours)", 1, 2160],
    ["minimumPredictions", "Minimum observations", 1, 100000],
    ["minimumVerifiedPredictions", "Minimum verified observations", 1, 100000],
    ["minimumEvaluableFailures", "Minimum evaluable failures", 1, 100000],
  ] as const;
  return html`<section aria-label="Fleet evidence">
    <h2>Fleet evidence</h2>
    <p>${report.totals.repositories} repositories · ${report.totals.needsAttention} need review · ${report.totals.unavailable} unavailable</p>
    <p class="muted">${report.window.start} to ${report.window.end}. Changes compare the preceding ${policy.windowDays} days.</p>
    <p class="notice">${report.notice}</p>
    ${report.unavailable.length ? html`<p class="bad">Evidence could not be loaded for: ${report.unavailable.join(", ")}. Retry before assessing these repositories.</p>` : html``}
    ${report.repositories.length ? html`<div style="overflow-x:auto"><table>
      <thead><tr><th>Repository</th><th>Observations</th><th>Verified</th><th>Selective / full</th><th>Selective change</th><th>Next step</th></tr></thead>
      <tbody>${report.repositories.map((repo) => html`<tr>
        <td>${repo.repository}<br><span class="muted">${repo.status}</span></td>
        <td class="num">${repo.current.predictions}</td>
        <td class="num">${repo.current.verifiedPredictions}${repo.verificationPercent === null ? "" : ` (${repo.verificationPercent.toFixed(1)}%)`}</td>
        <td class="num">${repo.current.selective} / ${repo.current.full}</td>
        <td class="num">${repo.selectivePercentChange === null ? "Not enough data" : `${repo.selectivePercentChange > 0 ? "+" : ""}${repo.selectivePercentChange.toFixed(1)} pp`}</td>
        <td>${repo.findings.length ? html`<ul>${repo.findings.map((finding) => html`<li>${FINDINGS[finding]}</li>`)}</ul>` : "Meets reporting policy; continue observation"}</td>
      </tr>`)}</tbody></table></div>` : html`<p class="empty">No available repository evidence yet.</p>`}
    <details><summary>Organization reporting policy · revision ${report.policy.revision}</summary>
      <p>These thresholds flag evidence for review. They never authorize skipping tests. Any missed failure is always flagged.</p>
      ${canEditPolicy ? html`<form id="evidence-policy-form">
        ${fields.map(([key, label, min, max]) => html`<p><label>${label}<br><input name="${key}" type="number" min="${min}" max="${max}" step="1" required value="${policy[key]}"></label></p>`)}
        <button type="button" data-policy-form="evidence-policy-form" data-revision="${report.policy.revision}"
          data-url="/v1/organizations/${organizationId}/evidence-policy" data-method="PUT" data-target="policy-result">Save reporting policy</button>
        <p id="policy-result" role="status"></p>
      </form>` : html`<p>Only an organization owner or admin can edit the policy.</p><ul>${fields.map(([key, label]) => html`<li>${label}: ${policy[key]}</li>`)}</ul>`}
      <h3>Policy history</h3>
      ${history.length ? html`<ul>${history.map((revision) => html`<li>Revision ${revision.revision} · ${revision.createdAt} · actor ${revision.actorUserId}
        <details><summary>Thresholds</summary><pre>${JSON.stringify(revision.policy, null, 2)}</pre></details></li>`)}</ul>`
        : html`<p class="muted">Using the default reporting policy. No saved revisions.</p>`}
    </details>
  </section>`;
}
