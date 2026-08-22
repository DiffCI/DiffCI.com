/**
 * Auth domain types (Part 2). AuthenticatedPrincipal is deliberately minimal - it is the ONLY thing
 * downstream authorization logic (organization membership checks) is allowed to trust about "who is
 * making this request." Nothing else in the product/billing/usage/runner modules should ever read a
 * user identity from anywhere except a resolved AuthenticatedPrincipal - never a raw header, never a
 * client-supplied body field.
 */

export type AuthenticationMethod = "session" | "development_header";

export interface AuthenticatedPrincipal {
  userId: string;
  /** Present only for authenticationMethod === "session" - a dev-header-authenticated principal has no
   * real session to reference. */
  sessionId?: string;
  authenticationMethod: AuthenticationMethod;
}

/**
 * Local session record (Part 4). `hashedToken` only - the raw bearer/cookie value is NEVER persisted
 * (Part 4: "Never store raw bearer/session tokens"). See sessions.ts hashSessionToken().
 */
export interface Session {
  sessionId: string;
  userId: string;
  hashedToken: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string;
  revokedAt?: string;
}
