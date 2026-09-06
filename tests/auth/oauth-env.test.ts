import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { readGithubOAuthEnv } from "../../src/auth/oauth-env.js";

const GOOD_ID = "Ov23liABCDEFGHIJKLMN"; // 20 chars, the OAuth App shape
const GOOD_SECRET = "0123456789abcdef0123456789abcdef01234567"; // 40 hex

describe("readGithubOAuthEnv", () => {
  it("accepts a real-looking pair", () => {
    const r = readGithubOAuthEnv({ GITHUB_OAUTH_CLIENT_ID: GOOD_ID, GITHUB_OAUTH_CLIENT_SECRET: GOOD_SECRET });
    assert.equal(r.ok, true);
  });

  it("the live failure: a client id that is only the Ctrl-V byte reads as not configured, with the reason", () => {
    const r = readGithubOAuthEnv({ GITHUB_OAUTH_CLIENT_ID: "\x16", GITHUB_OAUTH_CLIENT_SECRET: GOOD_SECRET });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /GITHUB_OAUTH_CLIENT_ID contains a control character/);
  });

  it("rejects a control character hidden inside an otherwise plausible value, whitespace, short values, and absence", () => {
    assert.match((readGithubOAuthEnv({ GITHUB_OAUTH_CLIENT_ID: GOOD_ID, GITHUB_OAUTH_CLIENT_SECRET: `${GOOD_SECRET}\r` }) as { reason: string }).reason, /CLIENT_SECRET contains a control character/);
    assert.match((readGithubOAuthEnv({ GITHUB_OAUTH_CLIENT_ID: ` ${GOOD_ID}`, GITHUB_OAUTH_CLIENT_SECRET: GOOD_SECRET }) as { reason: string }).reason, /whitespace/);
    assert.match((readGithubOAuthEnv({ GITHUB_OAUTH_CLIENT_ID: "abc", GITHUB_OAUTH_CLIENT_SECRET: GOOD_SECRET }) as { reason: string }).reason, /too short/);
    assert.match((readGithubOAuthEnv({ GITHUB_OAUTH_CLIENT_ID: GOOD_ID }) as { reason: string }).reason, /CLIENT_SECRET is not set/);
    assert.match((readGithubOAuthEnv({}) as { reason: string }).reason, /CLIENT_ID is not set/);
  });
});
