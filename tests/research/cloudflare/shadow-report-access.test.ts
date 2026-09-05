/**
 * Report access for a signed-in GitHub login (2026-09-05). GitHub's answer decides; anything GitHub did
 * not answer is unknown, never access; private tokens travel only with a "yes".
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { isValidGitHubLogin, listReportAccessForLogin, makeGitHubCollaboratorCheck, type ReportAccessCandidate } from "../../../src/research/cloudflare/shadow-report-access.js";

const candidates: ReportAccessCandidate[] = [
  { repository: "acme/private-app", state: "SHADOW_ACTIVE", isPrivate: true, reportToken: "tok-private" },
  { repository: "acme/public-lib", state: "VALIDATING", isPrivate: false, reportToken: "tok-public-unused" },
  { repository: "other/private-not-mine", state: "SHADOW_ACTIVE", isPrivate: true, reportToken: "tok-secret" },
  { repository: "acme/private-no-token", state: "VALIDATING", isPrivate: true },
  { repository: "flaky/repo", state: "SHADOW_ACTIVE", isPrivate: true, reportToken: "tok-flaky" },
];

describe("listReportAccessForLogin", () => {
  it("lists only repositories GitHub confirms, carries private tokens only with a yes, and reports unknowns", async () => {
    const asked: string[] = [];
    const result = await listReportAccessForLogin(
      {
        store: { async listReportAccessCandidates() { return candidates; } },
        async isCollaborator(repository, login) {
          asked.push(`${repository}:${login}`);
          if (repository === "other/private-not-mine") return "no";
          if (repository === "flaky/repo") throw new Error("GitHub 502");
          return "yes";
        },
      },
      "octocat",
    );
    assert.equal(result.checked, 5);
    assert.deepEqual(result.repositories.map((r) => r.repository), ["acme/private-app", "acme/public-lib", "acme/private-no-token"]);
    assert.equal(result.repositories[0]!.reportToken, "tok-private");
    assert.equal(result.repositories[1]!.reportToken, undefined, "a public repository's link never carries a token");
    assert.equal(result.repositories[2]!.reportToken, undefined, "no token exists yet - listed without one, never invented");
    assert.deepEqual(result.unknown, ["flaky/repo"], "a thrown check is unknown, not access and not silently dropped");
    assert.ok(!JSON.stringify(result).includes("tok-secret"), "a refused repository's token never leaves the store");
    assert.ok(asked.every((a) => a.endsWith(":octocat")));
  });

  it("refuses a login that is not a GitHub username before asking anything", async () => {
    await assert.rejects(
      listReportAccessForLogin({ store: { async listReportAccessCandidates() { throw new Error("must not be called"); } }, async isCollaborator() { return "yes"; } }, "../evil"),
      /not a valid GitHub username/,
    );
    assert.equal(isValidGitHubLogin("octo-cat"), true);
    assert.equal(isValidGitHubLogin("-octo"), false);
    assert.equal(isValidGitHubLogin("octo--cat"), false);
    assert.equal(isValidGitHubLogin("a".repeat(40)), false);
  });
});

describe("makeGitHubCollaboratorCheck", () => {
  function fakeFetch(status: number, seen: string[]): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(`${String(input)} ${(init?.headers as Record<string, string>)?.Authorization ?? ""}`);
      return new Response(null, { status });
    }) as unknown as typeof fetch;
  }
  it("maps 204 to yes, 404 to no, and everything else - including a missing token - to unknown", async () => {
    const seen: string[] = [];
    const yes = makeGitHubCollaboratorCheck(async () => "ghs_installation", fakeFetch(204, seen));
    assert.equal(await yes("acme/private-app", "octocat"), "yes");
    assert.match(seen[0]!, /\/repos\/acme\/private-app\/collaborators\/octocat Bearer ghs_installation$/);
    assert.equal(await makeGitHubCollaboratorCheck(async () => "t", fakeFetch(404, []))("acme/x", "octocat"), "no");
    assert.equal(await makeGitHubCollaboratorCheck(async () => "t", fakeFetch(403, []))("acme/x", "octocat"), "unknown", "the App lacking the permission is not a no");
    assert.equal(await makeGitHubCollaboratorCheck(async () => "t", fakeFetch(500, []))("acme/x", "octocat"), "unknown");
    const noToken: string[] = [];
    assert.equal(await makeGitHubCollaboratorCheck(async () => undefined, fakeFetch(204, noToken))("acme/x", "octocat"), "unknown");
    assert.equal(noToken.length, 0, "without an installation token GitHub is not even asked");
  });
});
