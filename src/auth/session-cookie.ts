/**
 * Session cookie construction (Part 8). All required production properties are set unconditionally by
 * buildSessionCookie() - there is no "insecure mode" toggle here; DIFFCI_ENVIRONMENT only ever gates
 * X-DiffCI-User-Id (src/auth/config.ts), never cookie security attributes.
 */
const SESSION_COOKIE_NAME = "diffci_session";

export function buildSessionCookie(rawToken: string, expiresAt: string): string {
  const maxAgeSeconds = Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
  return [
    `${SESSION_COOKIE_NAME}=${rawToken}`,
    "HttpOnly", // never readable by client-side JS - the whole point of a session token
    "Secure", // never sent over plain HTTP
    "SameSite=Lax", // sent on top-level navigation (needed for the OAuth callback redirect landing) but not on cross-site subresource/POST requests - CSRF protection is still separately enforced (src/auth/csrf.ts), this is defense in depth, not the primary mechanism (Part 9)
    "Path=/", // narrow enough already (this Worker serves nothing else); not scoped further since there is no sub-path segmentation to protect against
    `Max-Age=${maxAgeSeconds}`,
  ].join("; ");
}

/** A cookie that immediately expires - used to clear the session cookie on logout (Part 8). */
export function buildExpiredSessionCookie(): string {
  return [`${SESSION_COOKIE_NAME}=`, "HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=0"].join("; ");
}

export function buildCsrfCookie(token: string): string {
  // Deliberately NOT HttpOnly (see csrf.ts's header comment) - client JS must read it to echo it in a
  // request header. Still Secure + SameSite=Lax; short-lived, tied to the session's own lifetime by
  // being reissued alongside it rather than given its own separate expiry tracking.
  return [`diffci_csrf=${token}`, "Secure", "SameSite=Lax", "Path=/"].join("; ");
}
