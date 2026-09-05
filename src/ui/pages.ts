/**
 * The five screens (Phase 03 follow-up, 2026-08-26).
 *
 * Sign in -> pick or create an organization -> install the GitHub App -> mint a token and copy a
 * workflow -> watch observations arrive. That is the whole of "a stranger self-serves", and until this
 * existed every one of those steps was a curl command.
 *
 * These are pure functions from data to HTML. Everything they render has already been fetched through
 * the organization-scoped route functions that check membership, so no page here re-implements a
 * permission check - and none of them can, since they never see a store.
 */
import type { Organization, Repository } from "../product/types.js";
import type { UserReports } from "../product/report-access.js";
import type { InstallInstructions } from "../ingest/install.js";
import type { ObservationRecord } from "../ingest/types.js";
import type { ObservationSummary } from "../ingest/store.js";
import type { IngestTokenRecord } from "../ingest/token.js";
import type { LedgerRow, MonthlyLedger } from "../ledger/ledger.js";
import type { StoredInvoice } from "../billing/invoice-store.js";
import { formatUsdCents, type ReconciliationResult } from "../billing/metered.js";
import { html, layout, type SafeHtml } from "./render.js";

function shortSha(sha: string | undefined): string {
  return sha ? sha.slice(0, 9) : "—";
}

function statusClass(status: ObservationRecord["status"]): string {
  return status === "OBSERVED" ? "ok" : status === "REFUSED" ? "warn" : "bad";
}

/** A signed-out visitor. One button, and a plain statement of what happens next. */
export function renderSignedOut(options: { githubConfigured: boolean }): string {
  return layout({
    title: "Sign in",
    body: html`
      <h1>DiffCI observation console</h1>
      <p class="lede">
        DiffCI watches your CI and reports what a change-aware run would have selected. It never changes
        what your CI does — no test is run, skipped, cancelled or re-ordered by anything here.
      </p>
      ${options.githubConfigured
        ? html`<p><a href="/auth/github?redirect_to=/app"><button>Sign in with GitHub</button></a></p>`
        : html`<p class="notice">
            GitHub sign-in is not configured in this environment, so there is no way to sign in yet.
          </p>`}
      <footer>Observation only. Nothing here can write to your repositories.</footer>
    `,
  });
}

export function renderHome(options: { email: string; organizations: Organization[]; reports?: UserReports }): string {
  return layout({
    title: "Organizations",
    subtitle: options.email,
    signedIn: true,
    body: html`
      ${options.reports ? renderUserReports(options.reports) : html``}
      <h1>Your organizations</h1>
      <p class="lede">An organization is the billing and tenancy boundary. Repositories belong to exactly one.</p>
      ${options.organizations.length === 0
        ? html`<p class="empty">You do not belong to an organization yet. Create one below.</p>`
        : html`<table>
            <thead><tr><th>Name</th><th>Slug</th><th>Plan</th><th></th></tr></thead>
            <tbody>
              ${options.organizations.map(
                (organization) => html`<tr>
                  <td>${organization.name}</td>
                  <td><code>${organization.slug}</code></td>
                  <td>${organization.currentPlan}</td>
                  <td><a href="/app/orgs/${organization.id}">Open</a></td>
                </tr>`,
              )}
            </tbody>
          </table>`}

      <h2>Create an organization</h2>
      <div class="card">
        <div class="row">
          <input id="org-name" placeholder="Acme Inc" aria-label="Organization name">
          <input id="org-slug" placeholder="acme" aria-label="URL slug">
          <button data-url="/v1/organizations" data-method="POST" data-target="org-error"
                  onclick="this.dataset.body = JSON.stringify({ name: document.getElementById('org-name').value, slug: document.getElementById('org-slug').value })">
            Create
          </button>
        </div>
        <p id="org-error" class="muted">Lowercase letters, digits and hyphens in the slug.</p>
      </div>
    `,
  });
}

/** 2026-09-05: the signed-in user's shadow reports - every enrolled repository GitHub confirms they can
 * access, with the private ones' tokenised links. Failure to ask is said out loud, never shown as an
 * empty list: "no repositories" is a claim this page may only make after GitHub answered. */
function renderUserReports(reports: UserReports): SafeHtml {
  if (reports.status === "unavailable") {
    return html`
      <h1>Your shadow reports</h1>
      <p class="empty">Report access could not be checked right now: ${reports.reason}.</p>`;
  }
  return html`
    <h1>Your shadow reports</h1>
    <p class="lede">Repositories with DiffCI installed that GitHub confirms <code>${reports.login}</code> can access. A private repository's link carries its report token - share it only with people who may read that repository's CI timings.</p>
    ${reports.links.length === 0
      ? html`<p class="empty">No repository with DiffCI installed lists you as a collaborator yet. Just installed? Identification takes about a minute - reload after that.</p>`
      : html`<table>
          <thead><tr><th>Repository</th><th>Visibility</th><th>Observation</th><th></th></tr></thead>
          <tbody>
            ${reports.links.map(
              (link) => html`<tr>
                <td><code>${link.repository}</code></td>
                <td>${link.isPrivate ? "private" : "public"}</td>
                <td>${link.state}</td>
                <td>${link.url ? html`<a href="${link.url}">Open report</a>` : html`<span class="muted">report token not generated yet - reload in a minute</span>`}</td>
              </tr>`,
            )}
          </tbody>
        </table>`}
    ${reports.unknown.length > 0 ? html`<p class="muted">Could not check: ${reports.unknown.join(", ")} (GitHub did not answer for these; they are not hidden, just unverified).</p>` : html``}`;
}

export interface OrganizationPageData {
  email: string;
  organization: Organization;
  repositories: Repository[];
  tokens: IngestTokenRecord[];
  summary: ObservationSummary;
  recent: ObservationRecord[];
  /** Where "Install the GitHub App" points. Absent when the App is not configured in this environment. */
  installUrl?: string;
  /** 2026-09-05 seamless install: each connected repository's evidence-labelled report link. A private
   * repository's link carries its report token - this page is only ever rendered for a verified member. */
  reports?: Array<{ repository: string; url: string; isPrivate: boolean }>;
}

export function renderOrganization(data: OrganizationPageData): string {
  const reportByRepository = new Map((data.reports ?? []).map((r) => [r.repository, r]));
  const tokensByRepository = new Map<string, number>();
  for (const token of data.tokens) {
    if (token.revokedAt) continue;
    tokensByRepository.set(token.repositoryId, (tokensByRepository.get(token.repositoryId) ?? 0) + 1);
  }

  return layout({
    title: data.organization.name,
    subtitle: data.email,
    signedIn: true,
    body: html`
      <h1>${data.organization.name}</h1>
      <p class="lede">
        ${data.summary.total} observation${data.summary.total === 1 ? "" : "s"} received
        across ${data.summary.distinctRepositories} repositor${data.summary.distinctRepositories === 1 ? "y" : "ies"}.
      </p>

      <h2>Repositories</h2>
      ${data.installUrl
        ? html`<p><a href="${data.installUrl}"><button>Install the GitHub App</button></a>
            <span class="muted">GitHub asks which repositories to grant; DiffCI connects exactly those.</span></p>`
        : html`<p class="notice">
            The GitHub App is not configured in this environment, so repositories cannot be connected from here.
          </p>`}
      ${data.repositories.length === 0
        ? html`<p class="empty">No repositories connected yet.</p>`
        : html`<table>
            <thead><tr><th>Repository</th><th>Status</th><th>Branch</th><th class="num">Live tokens</th><th>Report</th><th></th></tr></thead>
            <tbody>
              ${data.repositories.map(
                (repository) => html`<tr>
                  <td>${repository.ownerName}</td>
                  <td>${repository.status}</td>
                  <td><code>${repository.defaultBranch}</code></td>
                  <td class="num">${tokensByRepository.get(repository.id) ?? 0}</td>
                  <td>${(() => {
                    const r = reportByRepository.get(repository.ownerName);
                    return r ? html`<a href="${r.url}">Open report</a>${r.isPrivate ? html` <span class="muted">(private link - keep it to your team)</span>` : ""}` : html`<span class="muted">not enrolled yet</span>`;
                  })()}</td>
                  <td><a href="/app/orgs/${data.organization.id}/repos/${repository.id}">Set up</a></td>
                </tr>`,
              )}
            </tbody>
          </table>`}

      <h2>Savings</h2>
      <p><a href="/app/orgs/${data.organization.id}/invoices">Invoices</a> ·
        <a href="/app/orgs/${data.organization.id}/ledger">This month's net savings ledger</a>
        <span class="muted">— measured against a simple path-rule CI, not against running everything.</span></p>

      <h2>Recent observations</h2>
      ${renderObservationsTable(data.recent)}

      <h2>Your data</h2>
      <div class="card">
        <p class="muted">
          Nothing DiffCI holds for this organization outlives 90 days. Removing the App from a repository
          deletes that repository's observations immediately. You can also delete everything now.
        </p>
        <button data-url="/v1/organizations/${data.organization.id}/observations" data-method="DELETE"
                data-confirm="Delete every observation stored for this organization? This cannot be undone."
                data-target="delete-result">Delete all observations</button>
        <p id="delete-result" class="muted"></p>
      </div>
    `,
  });
}

export interface RepositoryPageData {
  email: string;
  organization: Organization;
  repository: Repository;
  install: InstallInstructions;
  tokens: IngestTokenRecord[];
  observations: ObservationRecord[];
}

export function renderRepository(data: RepositoryPageData): string {
  const live = data.tokens.filter((token) => !token.revokedAt);
  return layout({
    title: data.repository.ownerName,
    subtitle: data.email,
    signedIn: true,
    body: html`
      <h1>${data.repository.ownerName}</h1>
      <p class="lede">
        <a href="/app/orgs/${data.organization.id}">${data.organization.name}</a> ·
        default branch <code>${data.repository.defaultBranch}</code> · ${data.repository.status}
      </p>

      <!-- There is deliberately no "this action is not pinned" notice here any more (B2, 2026-08-27).
           A page that renders a workflow naming a mutable ref, with a warning above it, is still a page
           handing someone a mutable ref. The instructions either exist and are SHA-pinned, or this page
           is never reached because the route refused with action_not_pinned. -->

      <h2>1. Create an ingest token</h2>
      <div class="card">
        <p class="muted">
          Scoped to this repository alone. Shown once, stored only as a hash, and revocable at any time.
        </p>
        <button data-url="/v1/organizations/${data.organization.id}/repositories/${data.repository.id}/ingest-tokens"
                data-body='{"name":"${data.repository.ownerName} CI"}' data-target="token-result">Create token</button>
        <div id="token-result"></div>
      </div>

      ${live.length === 0
        ? html`<p class="empty">No live tokens.</p>`
        : html`<table>
            <thead><tr><th>Token</th><th>Name</th><th>Created</th><th>Last used</th><th></th></tr></thead>
            <tbody>
              ${live.map(
                (token) => html`<tr>
                  <td><code>${token.tokenPrefix}…</code></td>
                  <td>${token.name ?? "—"}</td>
                  <td>${token.createdAt.slice(0, 10)}</td>
                  <td>${token.lastUsedAt ? token.lastUsedAt.slice(0, 16).replace("T", " ") : "never"}</td>
                  <td><button data-url="/v1/organizations/${data.organization.id}/ingest-tokens/${token.id}"
                              data-method="DELETE" data-confirm="Revoke this token? Any CI using it stops being able to send.">Revoke</button></td>
                </tr>`,
              )}
            </tbody>
          </table>`}

      <h2>2. Add the secret</h2>
      <p class="muted">
        In GitHub: Settings → Secrets and variables → Actions → New repository secret, named
        <code>${data.install.secretName}</code>, with the token above as its value.
      </p>

      <h2>3. Commit this workflow</h2>
      <p class="muted">As <code>${data.install.workflowPath}</code>. It adds one job that nothing depends on.</p>
      <pre><code>${data.install.workflowYaml}</code></pre>

      <h2>Observations</h2>
      ${renderObservationsTable(data.observations)}
    `,
  });
}

export interface LedgerPageData {
  email: string;
  organization: Organization;
  ledger: MonthlyLedger;
}

const VERDICT_LABEL: Record<LedgerRow["verdict"], string> = {
  NET_POSITIVE: "net saving",
  NO_OPPORTUNITY: "nothing to skip",
  NET_NEGATIVE: "DiffCI would have run more",
  NO_DATA: "nothing comparable",
};

const VERDICT_CLASS: Record<LedgerRow["verdict"], string> = {
  NET_POSITIVE: "ok",
  NO_OPPORTUNITY: "muted",
  NET_NEGATIVE: "bad",
  NO_DATA: "muted",
};

/**
 * The month, as a page. Two things it deliberately does NOT do: lead with the vs-full-suite number
 * (which is the flattering one), and hide a negative row. Both are visible, in that order of prominence.
 */
export function renderLedger(data: LedgerPageData): string {
  const { ledger } = data;
  const totals = ledger.totals;
  return layout({
    title: `Savings — ${ledger.month}`,
    subtitle: data.email,
    signedIn: true,
    body: html`
      <h1>Net savings, ${ledger.month}</h1>
      <p class="lede">
        <a href="/app/orgs/${data.organization.id}">${data.organization.name}</a> ·
        ${totals.observations} observation${totals.observations === 1 ? "" : "s"},
        ${totals.comparable} comparable.
      </p>

      <div class="card">
        <p>
          <strong>${totals.netTestsAvoided}</strong> test runs avoided this month, measured against what a
          simple path-rule CI would have run — <span class="muted">not against running everything, which
          would have read as ${totals.grossTestsAvoidedVsFullSuite}.</span>
        </p>
        <p class="muted">
          Counts: <strong>${totals.countTier}</strong>. Time and money: <strong>${totals.timeTier}</strong>.
        </p>
        <p class="notice">Not billable. ${totals.notBillableReason}</p>
      </div>

      <h2>By repository</h2>
      ${ledger.rows.length === 0
        ? html`<p class="empty">No observations were received in this month.</p>`
        : html`<table>
            <thead>
              <tr><th>Repository</th><th>Verdict</th><th class="num">Net avoided</th>
              <th class="num">vs full suite</th><th class="num">Comparable</th><th>Time evidence</th></tr>
            </thead>
            <tbody>
              ${ledger.rows.map(
                (row) => html`<tr>
                  <td>${row.ownerName ?? row.repositoryId}</td>
                  <td class="${VERDICT_CLASS[row.verdict]}">${VERDICT_LABEL[row.verdict]}</td>
                  <td class="num ${row.netTestsAvoided < 0 ? "bad" : ""}">${row.netTestsAvoided}</td>
                  <td class="num muted">${row.grossTestsAvoidedVsFullSuite}</td>
                  <td class="num">${row.comparable}/${row.observations}</td>
                  <td class="muted">${row.timeTier}</td>
                </tr>`,
              )}
            </tbody>
          </table>`}

      ${ledger.rows.some((row) => row.notComparable > 0)
        ? html`<h2>What could not be compared</h2>
            <ul class="muted">
              ${ledger.rows
                .filter((row) => row.notComparable > 0)
                .map((row) => html`<li>${row.ownerName ?? row.repositoryId}: ${row.notComparable} — ${row.notComparableReasons.join("; ")}</li>`)}
            </ul>`
        : ""}
    `,
  });
}

export interface InvoicesPageData {
  email: string;
  organization: Organization;
  invoices: StoredInvoice[];
  /** Set when the page was asked to reconcile one of them. */
  reconciliation?: { invoiceId: string; result: ReconciliationResult };
  /** Whether this member may issue and record payment. Read-only members see the bill, not the buttons. */
  canManage: boolean;
}

/**
 * The bill. Every line shows what it charges for, what evidence it rests on, and - when it charges
 * nothing - why. A zero invoice is a document here, not an empty state: it is the honest statement of a
 * month, and today it is the only kind this product can truthfully produce.
 */
export function renderInvoices(data: InvoicesPageData): string {
  return layout({
    title: "Invoices",
    subtitle: data.email,
    signedIn: true,
    body: html`
      <h1>Invoices</h1>
      <p class="lede">
        <a href="/app/orgs/${data.organization.id}">${data.organization.name}</a> ·
        DiffCI charges a share of measured net savings. A month whose savings are not MEASURED charges nothing.
      </p>

      <div class="card">
        <div class="row">
          <input id="invoice-month" placeholder="YYYY-MM" aria-label="Month">
          <button data-url="/v1/organizations/${data.organization.id}/invoices" data-method="POST" data-target="invoice-error"
                  onclick="this.dataset.body = JSON.stringify({ month: document.getElementById('invoice-month').value || undefined })">
            Prepare this month's invoice
          </button>
        </div>
        <p id="invoice-error" class="muted">A month already invoiced is returned unchanged, never re-priced.</p>
      </div>

      ${data.invoices.length === 0
        ? html`<p class="empty">No invoices yet.</p>`
        : data.invoices.map((invoice) => renderInvoice(data, invoice))}
    `,
  });
}

function renderInvoice(data: InvoicesPageData, invoice: StoredInvoice): SafeHtml {
  const reconciliation = data.reconciliation?.invoiceId === invoice.id ? data.reconciliation.result : undefined;
  return html`<div class="card">
    <h2>${invoice.periodMonth} — ${formatUsdCents(invoice.totalUsdCents)} <span class="muted">(${invoice.status})</span></h2>
    <p class="muted">
      ${invoice.savingsSharePercent}% of measured net savings ·
      basis: ${invoice.netTestsAvoided} net test runs avoided · money evidence: <strong>${invoice.evidenceTier}</strong>
    </p>
    ${invoice.chargeable ? "" : html`<p class="notice">Charges nothing. ${invoice.notChargeableReason}</p>`}

    <table>
      <thead><tr><th>Repository</th><th class="num">Net avoided</th><th class="num">Savings</th><th class="num">Amount</th><th>Evidence</th></tr></thead>
      <tbody>
        ${invoice.lines.map(
          (line) => html`<tr>
            <td>${line.description}${line.notChargeableReason ? html`<br><span class="muted">${line.notChargeableReason}</span>` : ""}</td>
            <td class="num ${line.quantity < 0 ? "bad" : ""}">${line.quantity}</td>
            <td class="num">${formatUsdCents(line.netSavingsUsdCents)}</td>
            <td class="num">${formatUsdCents(line.amountUsdCents)}</td>
            <td class="muted">${line.evidenceTier}</td>
          </tr>`,
        )}
      </tbody>
    </table>

    <div class="row">
      <a href="/app/orgs/${data.organization.id}/invoices?reconcile=${invoice.id}"><button>Reconcile line by line</button></a>
      ${data.canManage && invoice.status === "draft"
        ? html`<button data-url="/v1/organizations/${data.organization.id}/invoices/${invoice.id}/issue" data-method="POST">Issue</button>`
        : ""}
      ${data.canManage && invoice.status === "issued"
        ? html`<button data-url="/v1/organizations/${data.organization.id}/invoices/${invoice.id}/paid"
                       data-body='{"reference":"recorded in the console"}' data-method="POST"
                       data-confirm="Record this invoice as paid?">Record as paid</button>`
        : ""}
      ${data.canManage && invoice.status !== "paid" && invoice.status !== "void"
        ? html`<button data-url="/v1/organizations/${data.organization.id}/invoices/${invoice.id}/void" data-method="POST"
                       data-confirm="Void this invoice?">Void</button>`
        : ""}
    </div>
    ${invoice.paymentReference ? html`<p class="muted">Paid — ${invoice.paymentReference}</p>` : ""}

    ${reconciliation
      ? reconciliation.reconciled && !reconciliation.ledgerChanged
        ? html`<p class="ok">Reconciled: every line recomputes to exactly what was invoiced.</p>`
        : html`<p class="bad">
              ${reconciliation.ledgerChanged ? "The underlying observations have changed since this invoice was built. " : ""}
              ${reconciliation.differences.length} difference${reconciliation.differences.length === 1 ? "" : "s"}:
            </p>
            <ul class="muted">
              ${reconciliation.differences.map(
                (difference) => html`<li>${difference.scope} · ${difference.field}: invoiced ${difference.invoiced}, recomputes to ${difference.recomputed}</li>`,
              )}
            </ul>`
      : ""}
  </div>`;
}

function renderObservationsTable(observations: ObservationRecord[]): SafeHtml {
  if (observations.length === 0) {
    return html`<p class="empty">
      Nothing received yet. Reports appear here the first time the workflow runs on a pull request or a
      push to the default branch.
    </p>`;
  }
  return html`<table>
    <thead>
      <tr><th>Received</th><th>Commit</th><th>Status</th><th>Verdict</th><th class="num">Selected</th>
      <th class="num">Comparator</th><th>Untouched</th></tr>
    </thead>
    <tbody>
      ${observations.map(
        (observation) => html`<tr>
          <td>${observation.receivedAt.slice(0, 16).replace("T", " ")}</td>
          <td><code>${shortSha(observation.headSha)}</code></td>
          <td class="${statusClass(observation.status)}">${observation.status}${observation.status === "OBSERVED" ? "" : ` (${observation.stage})`}</td>
          <td>${observation.mode ?? "—"}</td>
          <td class="num">${observation.mode ? `${observation.selectedTestCount ?? 0}/${observation.totalTestCount ?? 0}` : "—"}</td>
          <td class="num">${observation.baselineMode === "FULL" ? "all" : (observation.baselineSelectedTestCount ?? "—")}</td>
          <td class="${observation.worktreeUnchanged ? "ok" : "bad"}">${observation.worktreeUnchanged ? "yes" : "NO"}</td>
        </tr>`,
      )}
    </tbody>
  </table>`;
}

/**
 * The claim screen (B3, 2026-08-27).
 *
 * Reached by anyone who installed the App from GitHub's own page rather than from inside the console -
 * which is most people, because that is the link the App's public URL and the marketing site both hand
 * out. Before this existed, that arrival was a bare 400 and a dead end.
 *
 * The page deliberately does NOT show what the installation covers. Repository names are not shown
 * until the claim has proved the viewer is the account that performed the install; until then, the only
 * facts on screen are ones they already supplied by arriving here.
 */
export function renderClaimInstallation(data: {
  email: string;
  installationId: string;
  accountLogin?: string;
  alreadyClaimed: boolean;
  known: boolean;
  organizations: Organization[];
}): string {
  const body = (() => {
    if (data.alreadyClaimed) {
      return html`<p class="notice">
          This installation is already connected to an organization. If that was not you, or you expected
          it somewhere else, remove the App from the repository on GitHub and install it again.
        </p>
        <p><a href="/app">Back to your organizations</a></p>`;
    }
    if (!data.known) {
      // Honest about the most common cause rather than implying the person did something wrong: the
      // webhook is what records an installation, and it can be late or unconfigured.
      return html`<p class="notice">
          DiffCI has not received this installation yet. GitHub delivers it separately from this redirect,
          so it can arrive a moment later - reload in a few seconds. If it never appears, the App's
          webhook is not reaching DiffCI, which is a configuration problem on our side, not yours.
        </p>
        <p><a href="/app">Back to your organizations</a></p>`;
    }
    if (data.organizations.length === 0) {
      return html`<p class="empty">
          You need an organization before an installation can be attached to one. Create one, then come
          back to this page.
        </p>
        <p><a href="/app">Create an organization</a></p>`;
    }
    return html`<p class="lede">
        Choose which organization this installation belongs to. Repositories already connected to a
        different organization are not moved - they stay where they are, and are reported as refused.
      </p>
      <form method="post" action="/v1/installations/claim" data-installation-id="${data.installationId}">
        <table>
          <thead>
            <tr><th>Organization</th><th>Plan</th><th></th></tr>
          </thead>
          <tbody>
            ${data.organizations.map(
              (organization) => html`<tr>
                <td>${organization.name}</td>
                <td>${organization.currentPlan}</td>
                <td><button type="submit" name="organizationId" value="${organization.id}">Attach here</button></td>
              </tr>`,
            )}
          </tbody>
        </table>
      </form>`;
  })();

  return layout({
    title: "Connect your installation",
    subtitle: data.email,
    signedIn: true,
    body: html`
      <h1>Connect your installation</h1>
      ${data.accountLogin ? html`<p class="muted">Installed on <code>${data.accountLogin}</code>.</p>` : ""} ${body}
    `,
  });
}
