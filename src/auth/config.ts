/**
 * Auth configuration + the hard safety gate for Part 3: development header auth (X-DiffCI-User-Id) must
 * be impossible to enable in a production configuration. This is enforced by THROWING at config-load
 * time (not just "defaulting off") - a Worker that fails to construct its auth config cannot serve any
 * request at all, which is the strongest guarantee available against a misconfigured deploy silently
 * accepting spoofed identity headers in production.
 */

export type DeploymentEnvironment = "development" | "production";

export interface AuthConfig {
  environment: DeploymentEnvironment;
  /** True only when environment === "development" AND the env var was explicitly set - see
   * parseAuthConfig(). Callers (authenticate.ts) must check this flag before EVER honoring
   * X-DiffCI-User-Id; the header's mere presence is never sufficient on its own. */
  allowDevHeaderAuth: boolean;
  sessionTtlMs: number;
}

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigError";
  }
}

export interface RawAuthEnv {
  DIFFCI_ENVIRONMENT?: string; // "development" | "production" - no default; must be explicit
  DIFFCI_ALLOW_DEV_HEADER_AUTH?: string; // "true" to opt in, anything else (including unset) is off
  DIFFCI_SESSION_TTL_MS?: string;
}

const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Throws AuthConfigError if:
 * - DIFFCI_ENVIRONMENT is missing or not one of the two recognized values (Part 3: "refuses to start
 *   publicly if insecure development auth is enabled in production" - an UNKNOWN environment is treated
 *   as production-equivalent risk and rejected outright, never assumed safe by default);
 * - DIFFCI_ALLOW_DEV_HEADER_AUTH=true is set while DIFFCI_ENVIRONMENT=production - this is the specific,
 *   named failure mode Part 3 requires the application to refuse to start over.
 */
export function parseAuthConfig(env: RawAuthEnv): AuthConfig {
  if (env.DIFFCI_ENVIRONMENT !== "development" && env.DIFFCI_ENVIRONMENT !== "production") {
    throw new AuthConfigError(
      `DIFFCI_ENVIRONMENT must be explicitly "development" or "production" (got: ${JSON.stringify(env.DIFFCI_ENVIRONMENT ?? null)}) - refusing to start with an unknown/unset environment rather than guessing which trust boundary applies`,
    );
  }
  const environment = env.DIFFCI_ENVIRONMENT;
  const devHeaderRequested = env.DIFFCI_ALLOW_DEV_HEADER_AUTH === "true";

  if (devHeaderRequested && environment === "production") {
    throw new AuthConfigError(
      "DIFFCI_ALLOW_DEV_HEADER_AUTH=true is set together with DIFFCI_ENVIRONMENT=production - this combination is never permitted. " +
        "The spoofable X-DiffCI-User-Id development identity header must never be honored in a production deployment. Refusing to start.",
    );
  }

  const allowDevHeaderAuth = devHeaderRequested && environment === "development";
  if (allowDevHeaderAuth) {
    // Part 3: "clear structured warning in development" - not console.error (which some log
    // pipelines treat as an alerting condition), a deliberate structured warning object instead.
    console.warn(
      JSON.stringify({
        level: "warning",
        message: "DIFFCI_ALLOW_DEV_HEADER_AUTH is enabled - X-DiffCI-User-Id will be trusted without verification. This must NEVER be enabled outside local development.",
        environment,
      }),
    );
  }

  let sessionTtlMs = DEFAULT_SESSION_TTL_MS;
  if (env.DIFFCI_SESSION_TTL_MS) {
    const parsed = Number(env.DIFFCI_SESSION_TTL_MS);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new AuthConfigError(`DIFFCI_SESSION_TTL_MS must be a positive number (got: ${env.DIFFCI_SESSION_TTL_MS})`);
    }
    sessionTtlMs = parsed;
  }

  return { environment, allowDevHeaderAuth, sessionTtlMs };
}
