/**
 * Phase 03 follow-up (2026-08-26): the console's pages.
 *
 * Server-rendered HTML built by string concatenation is exactly where injection lives, and every value
 * on these pages comes from outside: repository names from GitHub, organization names from whoever typed
 * them. So the first tests here are escaping tests, and the second concern is the opposite of injection -
 * that nothing which must stay secret is rendered at all.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { escapeHtml, html, renderSafe } from "../../src/ui/render.js";
import { renderHome, renderLedger, renderOrganization, renderRepository, renderSignedOut } from "../../src/ui/pages.js";
import { buildMonthlyLedger } from "../../src/ledger/ledger.js";
import { buildInstallInstructions } from "../../src/ingest/install.js";
import { TEST_PINNED_AGENT } from "../helpers/agent-artifact.js";
import type { Organization, Repository } from "../../src/product/types.js";
import type { ObservationRecord } from "../../src/ingest/types.js";

const organization: Organization = {
  id: "org-1",
  name: "Acme Inc",
  slug: "acme",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  billingStatus: "none",
  currentPlan: "free",
};

const repository: Repository = {
  id: "repo-1",
  organizationId: organization.id,
  provider: "github",
  providerRepositoryId: "111",
  ownerName: "acme/checkout",
  defaultBranch: "main",
  status: "active",
  shadowEnabled: false,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const observation: ObservationRecord = {
  id: "obs-1",
  organizationId: organization.id,
  repositoryId: repository.id,
  idempotencyKey: "k",
  schemaVersion: "diffci.observation.v1",
  status: "OBSERVED",
  stage: "complete",
  mode: "SELECTIVE",
  headSha: "abcdef1234567890",
  selectedTestCount: 3,
  totalTestCount: 40,
  baselineMode: "FULL",
  blindSpot: false,
  worktreeUnchanged: true,
  blockingWorkflowFindings: 0,
  pathsRedacted: false,
  identityVerified: true,
  producedAt: "2026-08-26T10:00:00.000Z",
  receivedAt: "2026-08-26T10:00:01.000Z",
  reportBytes: 900,
  report: {},
};

const install = buildInstallInstructions({ repository, agentArtifact: TEST_PINNED_AGENT, apiOrigin: "https://api.diffci.test" });

describe("HTML escaping", () => {
  it("escapes every interpolated value by default", () => {
    const rendered = renderSafe(html`<p>${'<script>alert("x")</script>'}</p>`);
    assert.equal(rendered, "<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>");
  });

  it("escapes values inside arrays, and composes nested templates without double-escaping", () => {
    const rendered = renderSafe(html`<ul>${["<b>", html`<li>ok</li>`]}</ul>`);
    assert.equal(rendered, "<ul>&lt;b&gt;<li>ok</li></ul>");
  });

  it("escapes quotes, so an attribute cannot be broken out of", () => {
    assert.equal(escapeHtml(`" onmouseover="alert(1)`), "&quot; onmouseover=&quot;alert(1)");
  });
});

describe("console pages", () => {
  it("offers sign-in, and says so plainly when GitHub is not configured", () => {
    assert.match(renderSignedOut({ githubConfigured: true }), /Sign in with GitHub/);
    const unconfigured = renderSignedOut({ githubConfigured: false });
    assert.equal(/Sign in with GitHub/.test(unconfigured), false);
    assert.match(unconfigured, /not configured/);
  });

  it("renders a repository name from GitHub without letting it become markup", () => {
    const hostile: Repository = { ...repository, ownerName: '"><img src=x onerror=alert(1)>' };
    const page = renderOrganization({
      email: "dev@acme.test",
      organization,
      repositories: [hostile],
      tokens: [],
      summary: { total: 0, observed: 0, refused: 0, errored: 0, selective: 0, full: 0, worktreeUnchanged: 0, distinctRepositories: 0 },
      recent: [],
    });
    assert.equal(page.includes("<img src=x"), false);
    assert.match(page, /&lt;img src=x/);
  });

  it("tells someone with no organizations what to do next", () => {
    const page = renderHome({ email: "dev@acme.test", organizations: [] });
    assert.match(page, /do not belong to an organization yet/);
    assert.match(page, /Create an organization/);
  });

  it("hides the install button when the App is not configured, rather than offering a dead link", () => {
    const base = {
      email: "dev@acme.test",
      organization,
      repositories: [repository],
      tokens: [],
      summary: { total: 1, observed: 1, refused: 0, errored: 0, selective: 1, full: 0, worktreeUnchanged: 1, distinctRepositories: 1 },
      recent: [observation],
    };
    assert.match(renderOrganization({ ...base, installUrl: "/app/install?organizationId=org-1" }), /Install the GitHub App/);
    const without = renderOrganization(base);
    assert.equal(/Install the GitHub App/.test(without), false);
    assert.match(without, /not configured in this environment/);
  });

  it("shows an observation as what it is: a selection, its comparator, and whether the checkout was touched", () => {
    const page = renderOrganization({
      email: "dev@acme.test",
      organization,
      repositories: [repository],
      tokens: [],
      summary: { total: 1, observed: 1, refused: 0, errored: 0, selective: 1, full: 0, worktreeUnchanged: 1, distinctRepositories: 1 },
      recent: [observation],
    });
    assert.match(page, /abcdef123/);
    assert.match(page, /3\/40/);
    assert.match(page, /SELECTIVE/);
    assert.match(page, /all<\/td>/, "a FULL comparator reads as 'all', not as a number that looks like a saving");
  });

  it("renders the empty state instead of an empty table", () => {
    const page = renderOrganization({
      email: "dev@acme.test",
      organization,
      repositories: [],
      tokens: [],
      summary: { total: 0, observed: 0, refused: 0, errored: 0, selective: 0, full: 0, worktreeUnchanged: 0, distinctRepositories: 0 },
      recent: [],
    });
    assert.match(page, /Nothing received yet/);
    assert.match(page, /No repositories connected yet/);
  });

  it("never renders a credential - only its prefix, and only for live ones", () => {
    const page = renderRepository({
      email: "dev@acme.test",
      organization,
      repository,
      install,
      tokens: [
        { id: "t1", organizationId: organization.id, repositoryId: repository.id, tokenPrefix: "dci_abcd1234", name: "CI", createdAt: "2026-08-20T00:00:00.000Z", lastUsedAt: "2026-08-26T09:00:00.000Z" },
        { id: "t2", organizationId: organization.id, repositoryId: repository.id, tokenPrefix: "dci_dead0000", createdAt: "2026-08-19T00:00:00.000Z", revokedAt: "2026-08-21T00:00:00.000Z" },
      ],
      observations: [observation],
    });

    assert.match(page, /dci_abcd1234/);
    assert.equal(page.includes("dci_dead0000"), false, "a revoked token is not a live one and is not listed");
    assert.match(page, /Create an ingest token/);
    // The workflow to copy, with the secret referenced rather than embedded.
    assert.match(page, /secrets.DIFFCI_TOKEN/);
  });

  it("leads the ledger with the honest comparator and names the flattering one as flattering", () => {
    const page = renderLedger({
      email: "dev@acme.test",
      organization,
      ledger: buildMonthlyLedger({
        organizationId: organization.id,
        month: "2026-08",
        repositoryNames: new Map([[repository.id, repository.ownerName]]),
        observations: [{ ...observation, receivedAt: "2026-08-10T10:00:00.000Z", totalTestCount: 40, selectedTestCount: 3, baselineMode: "SELECTIVE", baselineSelectedTestCount: 20 }],
      }),
    });

    assert.match(page, /17/, "the net figure against the real comparator");
    assert.match(page, /not against running everything, which\s+would have read as 37/);
    assert.match(page, /Not billable/);
    assert.match(page, /UNKNOWN/, "time evidence is stated, not omitted");
  });

  it("renders a net-negative month as bad news rather than as a small saving", () => {
    const page = renderLedger({
      email: "dev@acme.test",
      organization,
      ledger: buildMonthlyLedger({
        organizationId: organization.id,
        month: "2026-08",
        repositoryNames: new Map([[repository.id, repository.ownerName]]),
        observations: [{ ...observation, receivedAt: "2026-08-10T10:00:00.000Z", mode: "FULL", totalTestCount: 40, baselineMode: "SELECTIVE", baselineSelectedTestCount: 5 }],
      }),
    });

    assert.match(page, /DiffCI would have run more/);
    assert.match(page, /class="num bad">-35/);
  });

  // Was: "shows the unpinned-action warning where the person installing will see it". The warning is
  // gone because the state it warned about is unreachable - the route refuses before this page renders.
  // What replaces it is the stronger property: whatever this page shows a customer to copy names an
  // exact, immutable agent version, and nothing that could resolve to something newer.
  it("never renders a mutable agent reference for the customer to copy", () => {
    const page = renderRepository({ email: "dev@acme.test", organization, repository, install, tokens: [], observations: [] });
    assert.match(page, /@diffci\/observer@1\.4\.2/);
    for (const mutable of ["@latest", "@next", "@beta", "^1.", "~1.", "1.x"]) {
      assert.equal(page.includes(mutable), false, `the console must never render "${mutable}"`);
    }
  });
});
