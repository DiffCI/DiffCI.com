/**
 * Tarball / manifest checksum helpers for the analysis fan-out (2026-08-23).
 *
 * The engine-checksum gate used to trust a client-supplied string and a manifest inside the same
 * tarball (both forgeable together). It is now the tarball's own SHA-256, computed by the Worker from
 * the R2 object and compared to the pack record's `tarballSha256`, plus an in-container re-check after
 * transfer. These helpers are pure and shared by the Worker and the tests.
 */

/** SHA-256 hex of a byte buffer via Web Crypto (available identically in Workers and Node >= 15). */
export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Normalize a caller-provided hex string for comparison (trim + lowercase). */
export function normalizeHex(hex: string): string {
  return hex.trim().toLowerCase();
}

/** Constant-time-ish comparison of two already-normalized hex strings. */
export function hexMatches(actual: string, expected: string): boolean {
  return normalizeHex(actual) === normalizeHex(expected);
}

/** True when a string looks like a full 64-char SHA-256 hex digest. */
export function isSha256Hex(value: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(value.trim());
}