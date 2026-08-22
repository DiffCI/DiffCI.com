/**
 * The single chokepoint that resolves an AuthenticatedPrincipal from an incoming Request (Part 2).
 * Every organization-scoped route must call this - and ONLY this - to learn who is making the request.
 * No route may read X-DiffCI-User-Id (or any other header) directly.
 */
import type { AuthConfig } from "./config.js";
import type { SessionStore } from "./sessions.js";
import type { AuthenticatedPrincipal } from "./types.js";

const SESSION_COOKIE_NAME = "diffci_session";

function extractSessionToken(request: Request): string | undefined {
  const auth = request.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);

  const cookieHeader = request.headers.get("Cookie");
  if (cookieHeader) {
    for (const part of cookieHeader.split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name === SESSION_COOKIE_NAME) return rest.join("=");
    }
  }
  return undefined;
}

export interface AuthenticateDeps {
  config: AuthConfig;
  sessionStore: SessionStore;
}

/**
 * Resolution order:
 * 1. A real session (Bearer token or diffci_session cookie), verified against the DB - the ONLY path
 *    that can ever succeed in production (config.allowDevHeaderAuth is provably false there, enforced
 *    by parseAuthConfig() throwing at startup otherwise - see config.ts).
 * 2. X-DiffCI-User-Id, ONLY when config.allowDevHeaderAuth === true (which itself can only be true when
 *    environment === "development" - see config.ts). This branch is dead code in any config that could
 *    legally run in production.
 * Returns null (never throws) on any failure to authenticate - callers translate that to 401.
 */
export async function authenticateRequest(request: Request, deps: AuthenticateDeps): Promise<AuthenticatedPrincipal | null> {
  const rawToken = extractSessionToken(request);
  if (rawToken) {
    const session = await deps.sessionStore.getValidSessionByRawToken(rawToken);
    if (session) {
      await deps.sessionStore.touchSession(session.sessionId);
      return { userId: session.userId, sessionId: session.sessionId, authenticationMethod: "session" };
    }
    // A presented-but-invalid session token must NOT fall through to dev-header auth, even in
    // development - an explicitly-failed real auth attempt is a stronger signal than "no attempt was
    // made" and should not be silently downgraded to a weaker auth path.
    return null;
  }

  if (deps.config.allowDevHeaderAuth) {
    const devUserId = request.headers.get("X-DiffCI-User-Id");
    if (devUserId) {
      return { userId: devUserId, authenticationMethod: "development_header" };
    }
  }

  return null;
}
