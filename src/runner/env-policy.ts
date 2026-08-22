/**
 * R2 environment allowlist (Parts 8, 9, 18). The repository workload process must never inherit the
 * runner/control-plane environment wholesale - it gets an explicitly constructed, minimal environment
 * built ONLY from SAFE_ENV_ALLOWLIST keys, never a spread of `process.env`.
 */
export const SAFE_ENV_ALLOWLIST: ReadonlySet<string> = new Set(["PATH", "HOME", "LANG", "LC_ALL", "TZ", "NODE_ENV", "NPM_CONFIG_CACHE"]);

// Defense-in-depth substring check (Part 9) - even a value explicitly passed by trusted DiffCI code
// (never caller input) is rejected if its KEY looks credential-shaped, so a future careless edit can't
// silently widen the allowlist into a leak.
const FORBIDDEN_KEY_SUBSTRINGS = ["TOKEN", "SECRET", "PASSWORD", "CREDENTIAL", "API_KEY", "APIKEY", "PRIVATE_KEY", "AUTH"];

export function isForbiddenEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return FORBIDDEN_KEY_SUBSTRINGS.some((f) => upper.includes(f));
}

export interface BuildSanitizedEnvInput {
  /** The process env to allowlist-filter FROM (e.g. process.env inside the trusted agent) - only keys
   * in SAFE_ENV_ALLOWLIST are ever copied out of this, nothing else, regardless of what else it holds. */
  sourceEnv: Record<string, string | undefined>;
  /** DiffCI-generated, non-secret job metadata to add on top - e.g. {DIFFCI_JOB_ID: "..."} - still
   * checked against isForbiddenEnvKey() before being included. */
  extra?: Record<string, string>;
}

/** Builds the exact environment object the repository workload process receives. Never includes a key
 * not explicitly allowlisted or explicitly passed as safe `extra` metadata - CI=true is always set
 * (many test runners key behavior off it, and it carries no secret). Throws if `extra` contains a
 * forbidden-looking key, rather than silently dropping or including it. */
export function buildSanitizedWorkloadEnv(input: BuildSanitizedEnvInput): Record<string, string> {
  const result: Record<string, string> = { CI: "true" };
  for (const key of SAFE_ENV_ALLOWLIST) {
    const value = input.sourceEnv[key];
    if (value !== undefined) result[key] = value;
  }
  for (const [key, value] of Object.entries(input.extra ?? {})) {
    if (isForbiddenEnvKey(key)) throw new Error(`refusing to include "${key}" in the sanitized workload environment - matches a forbidden credential-shaped pattern`);
    result[key] = value;
  }
  return result;
}

/**
 * R2 Part 9 leak test primitive: given the ACTUAL env object a workload process observed (e.g. as
 * reported back by a diagnostic program the workload ran), verify none of a list of known-secret
 * raw values appear anywhere in it - by key OR by value. Returns pass/fail plus only SAFE metadata
 * (which keys were present, never their values, never the secret values themselves) - this function's
 * own result must never be logged with the full env dumped alongside it.
 */
export interface EnvLeakCheckResult {
  pass: boolean;
  observedKeys: string[];
  leakedKeys: string[]; // keys whose VALUE matched a known secret - safe to report (key names only)
  forbiddenKeysPresent: string[]; // keys that are forbidden-shaped and present at all, regardless of value
}

export function checkForEnvLeak(observedEnv: Record<string, string>, knownSecretValues: readonly string[]): EnvLeakCheckResult {
  const observedKeys = Object.keys(observedEnv);
  const leakedKeys = observedKeys.filter((k) => knownSecretValues.includes(observedEnv[k]!));
  const forbiddenKeysPresent = observedKeys.filter((k) => isForbiddenEnvKey(k));
  return { pass: leakedKeys.length === 0 && forbiddenKeysPresent.length === 0, observedKeys, leakedKeys, forbiddenKeysPresent };
}
