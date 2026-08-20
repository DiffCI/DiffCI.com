/**
 * Retry policy for transient Cloudflare Container lifecycle failures. Deliberately separated from
 * validation-worker.ts (which imports @cloudflare/sandbox and pulls in Workers-runtime-only
 * "cloudflare:" virtual modules at import time) so this pure logic can be unit-tested in plain Node -
 * see tests/research/cloudflare/retry.test.ts.
 *
 * Added 2026-08-20 after a real finding in the Stage 0 small batch: unjs/h3's first validation attempt
 * failed with "the sandbox container stopped while the operation was pending" - a transient
 * max_instances:1 container-lifecycle race, recovered cleanly on a retry ~1 minute later. See
 * diffci/docs/research/2026-08-20-stage0-small-batch-report.md.
 */

/** Transient container-lifecycle failures only. Deliberately narrow: this must NOT match application-
 * level failures (a real analysis bug, a malformed repo, an actual git error) - those should fail fast
 * and be reported, not silently retried into a false "it worked". */
const TRANSIENT_CONTAINER_ERROR_PATTERNS = [
  /sandbox container stopped/i,
  /container (instance )?(is )?(not ready|unavailable|terminated|crashed)/i,
  /durable object (reset|is overloaded|exceeded)/i,
  /network connection lost/i,
  // Real finding, Stage 0 medium-batch Gate B (2026-08-21): pmndrs/zustand's sample-phase exec (clone +
  // deterministic sample, normally a few seconds for this repo, confirmed many times earlier this
  // session) hit "Command timed out after 120000ms" and, because no pattern above matched it, failed
  // immediately with zero retries. Manually retrying the exact same call succeeded cleanly seconds
  // later - strong evidence of transient network/platform slowness, not a real hang. A genuinely
  // oversized or truly-hung repo will still exhaust all 3 attempts and fail (same bound as any other
  // transient pattern here) - this isn't masking real timeouts, just giving the common transient case a
  // chance to recover instead of failing an entire repository over one slow clone.
  /command timed out/i,
];

export function isTransientContainerError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return TRANSIENT_CONTAINER_ERROR_PATTERNS.some((p) => p.test(message));
}

export interface RetryOutcome<T> {
  result: T;
  attempts: number;
  retryReasons: string[];
}

/** Retries a whole per-repository attempt (fresh container, full cold+warm run) on a transient
 * container-lifecycle failure - not an individual sandbox.exec() call. A partial mid-flow retry isn't
 * safe: the "warm" pass's resumability proof specifically requires the SAME container session as
 * "cold", so a failure partway through has to restart the whole attempt against a genuinely fresh
 * session, not resume against a container that may be in an unknown state.
 *
 * `sleepMs` is injectable so tests can run in milliseconds instead of the real ~3s/6s backoff. */
export async function withContainerRetry<T>(
  attemptFn: (attempt: number) => Promise<T>,
  options: { maxAttempts?: number; sleepMs?: (attempt: number) => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<RetryOutcome<T>> {
  const maxAttempts = options.maxAttempts ?? 3;
  const sleepMs = options.sleepMs ?? ((attempt: number) => attempt * 3_000);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const retryReasons: string[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await attemptFn(attempt);
      return { result, attempts: attempt, retryReasons };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isTransientContainerError(error) || attempt === maxAttempts) {
        if (retryReasons.length > 0) {
          // Attach retry history to the final thrown error so the caller's error response still
          // shows what was tried, instead of only the last failure.
          const wrapped = error instanceof Error ? error : new Error(message);
          wrapped.message = `${wrapped.message} (after ${attempt} attempt(s); prior: ${retryReasons.join("; ")})`;
          throw wrapped;
        }
        throw error;
      }
      retryReasons.push(`attempt ${attempt}: ${message}`);
      // Give the platform time to actually finish tearing down the dead container before the next
      // attempt tries to start a new one - the race observed in the small batch was immediate reuse.
      await sleep(sleepMs(attempt));
    }
  }
  // Unreachable - the loop always returns or throws - but keeps TypeScript's control-flow analysis happy.
  throw new Error("withContainerRetry: exhausted attempts without a result or a thrown error");
}
