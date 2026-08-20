/**
 * Cloudflare Sandbox session-id construction. Deliberately dependency-free from @cloudflare/sandbox
 * (see retry.ts's header comment for why) so it's unit-testable in plain Node - both use the standard
 * Web Crypto API, available in both the Workers runtime and Node.
 *
 * Real finding from the 2026-08-20 larger-study run: spring-projects/spring-petclinic failed outright
 * with "Sandbox ID must be 1-63 characters long" - a naive `validate-${owner}-${name}-attempt${attempt}
 * -${Date.now()}` session id overflows 63 characters for long owner/name combinations. Hashing
 * owner/name to a fixed-length id keeps this well under the limit regardless of repository name length.
 */

const SANDBOX_SESSION_ID_MAX_LENGTH = 63;

export async function shortHash(input: string, bytes = 6): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest).slice(0, bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Deterministic per (owner, name) - same repo always hashes to the same prefix, useful for debugging -
 * and still unique per attempt via the attempt number and a timestamp suffix. Bounded length by
 * construction: "v-" (2) + hash (12 hex chars for the default 6 bytes) + "-a" (2) + attempt (assumed
 * 1-2 digits) + "-" (1) + timestamp (13 digits) = well under SANDBOX_SESSION_ID_MAX_LENGTH regardless
 * of how long owner/name are. */
export async function buildSandboxSessionId(owner: string, name: string, attempt: number, now: number = Date.now()): Promise<string> {
  const id = `v-${await shortHash(`${owner}/${name}`)}-a${attempt}-${now}`;
  if (id.length > SANDBOX_SESSION_ID_MAX_LENGTH) {
    // Should be unreachable given the fixed-length construction above, but fail loudly rather than
    // silently sending an invalid id to the Sandbox SDK if that ever changes.
    throw new Error(`buildSandboxSessionId: constructed id "${id}" (${id.length} chars) exceeds the ${SANDBOX_SESSION_ID_MAX_LENGTH}-char Sandbox limit`);
  }
  return id;
}
