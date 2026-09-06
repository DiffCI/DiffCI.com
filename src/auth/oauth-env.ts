/**
 * GitHub OAuth credentials from the environment, validated before use (2026-09-05).
 *
 * Found live: `wrangler secret put` in a terminal that does not paste on Ctrl-V stored the keystroke
 * itself - a single 0x16 byte - as the client id, and the sign-in button sent every user to a GitHub
 * 404. A credential that cannot be right must read as "not configured", with a reason in the logs,
 * rather than as a working button.
 */
export interface GithubOAuthCredentials {
  clientId: string;
  clientSecret: string;
}

export type GithubOAuthEnvResult = { ok: true; credentials: GithubOAuthCredentials } | { ok: false; reason: string };

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

function check(name: string, value: string | undefined, minLength: number): string | undefined {
  if (value === undefined || value === "") return `${name} is not set`;
  if (CONTROL_CHARS.test(value)) return `${name} contains a control character (a paste that did not happen? re-enter it)`;
  if (value.trim() !== value) return `${name} has leading or trailing whitespace - re-enter it`;
  if (value.length < minLength) return `${name} is too short to be a GitHub credential (${value.length} chars)`;
  return undefined;
}

/** GitHub OAuth App client ids are 20 characters (or "Iv1."/"Iv23" + 16 for App-style ids); secrets are 40 hex. */
export function readGithubOAuthEnv(env: { GITHUB_OAUTH_CLIENT_ID?: string; GITHUB_OAUTH_CLIENT_SECRET?: string }): GithubOAuthEnvResult {
  const idProblem = check("GITHUB_OAUTH_CLIENT_ID", env.GITHUB_OAUTH_CLIENT_ID, 16);
  if (idProblem) return { ok: false, reason: idProblem };
  const secretProblem = check("GITHUB_OAUTH_CLIENT_SECRET", env.GITHUB_OAUTH_CLIENT_SECRET, 32);
  if (secretProblem) return { ok: false, reason: secretProblem };
  return { ok: true, credentials: { clientId: env.GITHUB_OAUTH_CLIENT_ID!, clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET! } };
}
