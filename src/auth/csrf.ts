/**
 * CSRF protection (Part 9) via a signed double-submit token - chosen over a synchronizer token because
 * it needs no server-side storage (no new table, no cleanup job) while still being resistant to a naive
 * double-submit bypass: the token is HMAC-signed over the session id, so an attacker who cannot read the
 * cookie (which SameSite/HttpOnly-adjacent browser same-origin policy prevents for a cross-site request)
 * cannot forge a token that verifies against a DIFFERENT victim session, even if they can trivially make
 * the browser send an unrelated cross-site request. Part 9 explicitly says "Do not assume SameSite alone
 * is sufficient" - this mechanism does not rely on SameSite at all; it is checked independently.
 *
 * The CSRF cookie itself is deliberately NOT HttpOnly (client-side JS must be able to read it to echo it
 * back in a request header) - this is standard for the double-submit pattern and is not a weakening of
 * the SESSION cookie's own HttpOnly protection (src/auth/session-cookie.ts), which remains HttpOnly at
 * all times.
 *
 * OAuth state (src/auth/oauth-store.ts oauth_states) is a SEPARATE mechanism protecting a different
 * threat (a forged OAuth callback), not a substitute for this (Part 9: "OAuth callback state
 * verification is separate from general CSRF protection").
 */

export const CSRF_COOKIE_NAME = "diffci_csrf";
export const CSRF_HEADER_NAME = "X-CSRF-Token";

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digestBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(digestBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Generates a new CSRF token bound to `sessionId`. The token format is `<nonce>.<hmac>`, where hmac =
 * HMAC-SHA256(secret, sessionId + "." + nonce) - the session id itself is never embedded in the token
 * value, only mixed into the signature, so the token alone reveals nothing about which session it binds. */
export async function generateCsrfToken(secret: string, sessionId: string): Promise<string> {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const signature = await hmacHex(secret, `${sessionId}.${nonce}`);
  return `${nonce}.${signature}`;
}

/**
 * A request is CSRF-protected iff:
 * 1. a CSRF cookie is present, AND
 * 2. a matching header is present, AND
 * 3. cookie value === header value (double-submit), AND
 * 4. the token's signature verifies against the CURRENT requesting session's id (binds it to a specific
 *    session, not just "some cookie value the client happened to send").
 * All four must hold; missing/mismatched/invalid-signature all return false uniformly.
 */
export async function verifyCsrfToken(secret: string, sessionId: string, cookieValue: string | undefined, headerValue: string | undefined): Promise<boolean> {
  if (!cookieValue || !headerValue) return false;
  if (!timingSafeEqual(cookieValue, headerValue)) return false;

  const [nonce, signature] = cookieValue.split(".");
  if (!nonce || !signature) return false;
  const expectedSignature = await hmacHex(secret, `${sessionId}.${nonce}`);
  return timingSafeEqual(signature, expectedSignature);
}
