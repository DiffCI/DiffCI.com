/**
 * Dashboard report links (2026-09-05): built from the research Worker's answer, private tokens only in
 * private links, and every failure said out loud rather than shown as "no repositories".
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { buildReportUrl, loadUserReports } from "../../src/product/report-access.js";
import { renderHome } from "../../src/ui/pages.js";

function researchWorker(status: number, body: unknown, seen: Request[] = []) {
  return {
    async fetch(request: Request) {
      seen.push(request);
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    },
  };
}

describe("loadUserReports", () => {
  it("turns the research Worker's answer into links, with the token only on private repositories", async () => {
    const seen: Request[] = [];
    const reports = await loadUserReports(
      {
        researchWorker: researchWorker(200, { ok: true, login: "octocat", repositories: [
          { repository: "acme/private-app", state: "SHADOW_ACTIVE", isPrivate: true, reportToken: "tok-private" },
          { repository: "acme/public-lib", state: "VALIDATING", isPrivate: false },
          { repository: "acme/private-no-token", state: "VALIDATING", isPrivate: true },
        ], unknown: ["flaky/repo"] }, seen),
        dispatchToken: "dispatch-secret",
        reportBaseUrl: "https://example.test/v1/shadow/report",
      },
      "octocat",
    );
    assert.equal(reports.status, "ok");
    if (reports.status !== "ok") return;
    assert.equal(seen[0]!.headers.get("Authorization"), "Bearer dispatch-secret");
    assert.equal(new URL(seen[0]!.url).searchParams.get("login"), "octocat");
    assert.equal(reports.links[0]!.url, "https://example.test/v1/shadow/report?repository=acme%2Fprivate-app&days=7&token=tok-private");
    assert.equal(reports.links[1]!.url, "https://example.test/v1/shadow/report?repository=acme%2Fpublic-lib&days=7");
    assert.equal(reports.links[2]!.url, undefined, "no token yet means no link, not a token-less private link");
    assert.deepEqual(reports.unknown, ["flaky/repo"]);
  });

  it("is unavailable - with the reason - when there is no login, no binding, a failing answer, or a thrown fetch", async () => {
    const worker = researchWorker(200, { ok: true, repositories: [] });
    assert.match((await loadUserReports({ researchWorker: worker, dispatchToken: "t" }, null) as { reason: string }).reason, /no GitHub login/);
    assert.match((await loadUserReports({ dispatchToken: "t" }, "octocat") as { reason: string }).reason, /not connected/);
    assert.match((await loadUserReports({ researchWorker: worker }, "octocat") as { reason: string }).reason, /not connected/);
    assert.match((await loadUserReports({ researchWorker: researchWorker(401, { ok: false, error: "unauthorized" }), dispatchToken: "t" }, "octocat") as { reason: string }).reason, /answered 401: unauthorized/);
    const thrown = { async fetch() { throw new Error("binding down"); } };
    assert.match((await loadUserReports({ researchWorker: thrown, dispatchToken: "t" }, "octocat") as { reason: string }).reason, /binding down/);
  });

  it("buildReportUrl keeps the base route's path and encodes the repository", () => {
    assert.equal(buildReportUrl("https://r.test/v1/shadow/report", "a/b", "x y"), "https://r.test/v1/shadow/report?repository=a%2Fb&days=7&token=x+y");
  });
});

describe("renderHome with reports", () => {
  it("renders the links, the unknowns, and the unavailable reason - never an empty table for a failed check", () => {
    const ok = renderHome({ email: "u@example.test", organizations: [], reports: { status: "ok", login: "octocat", unknown: ["flaky/repo"], links: [
      { repository: "acme/private-app", isPrivate: true, state: "SHADOW_ACTIVE", url: "https://r.test/v1/shadow/report?repository=acme%2Fprivate-app&days=7&token=tok" },
      { repository: "acme/private-no-token", isPrivate: true, state: "VALIDATING" },
    ] } });
    assert.match(ok, /Your shadow reports/);
    assert.match(ok, /href="https:\/\/r\.test\/v1\/shadow\/report\?repository=acme%2Fprivate-app&amp;days=7&amp;token=tok"/);
    assert.match(ok, /report token not generated yet/);
    assert.match(ok, /Could not check: flaky\/repo/);

    const unavailable = renderHome({ email: "u@example.test", organizations: [], reports: { status: "unavailable", reason: "the report service is not connected in this environment" } });
    assert.match(unavailable, /Report access could not be checked right now: the report service is not connected/);
    assert.doesNotMatch(unavailable, /No repository with DiffCI installed lists you/);

    const none = renderHome({ email: "u@example.test", organizations: [], reports: { status: "ok", login: "octocat", unknown: [], links: [] } });
    assert.match(none, /No repository with DiffCI installed lists you as a collaborator yet/);
  });
});
