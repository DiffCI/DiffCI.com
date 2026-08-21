/**
 * Shadow source-version identity and integrity (2026-08-21 fix). Before this module existed, the
 * autonomous shadow-cron/webhook pollers loaded "whatever is currently in R2 at shadow/source/current.tgz"
 * with no way to tell whether that archive actually reflected `main` - a deploy that touched `src/`
 * without a matching `npm run shadow:upload-source` silently kept polling with the OLD implementation
 * forever, and nothing surfaced that fact anywhere. `docs/CURRENT_STATE.md` (2026-08-21) caught exactly
 * this: the deployed archive was stamped `e58fdfb` while `main` had moved 4 commits past it.
 *
 * The fix establishes one invariant, checked before every autonomous poll:
 *
 *   expected source SHA (env.EXPECTED_SOURCE_SHA, stamped onto the Worker at deploy time via
 *   `wrangler deploy --var EXPECTED_SOURCE_SHA:<HEAD>`, see scripts/deploy-research-sandbox.ts)
 *     ==
 *   archive source SHA (the git commit scripts/upload-shadow-source.ts actually packaged, stored in the
 *   R2 pointer object at shadow/source/current-meta)
 *
 * A mismatch, or either side being unavailable/malformed, must never be treated as "close enough" - see
 * computeSourceIntegrity below. This module is pure decision logic only (no R2/D1 access), unit-tested
 * exhaustively in tests/research/cloudflare/shadow-source-integrity.test.ts - the same DI split
 * shadow-cron.ts and orchestrator-plan.ts use. validation-worker.ts wires the real R2 reads.
 */

/** A full, lowercase git commit SHA - the one and only version identity this module trusts. Rejects
 * short SHAs, uppercase hex, and anything else: a truncated or case-varied SHA is exactly the kind of
 * "looks right, isn't guaranteed unique" value the "manually supplied arbitrary label" language in the
 * task this fixes explicitly warns against. */
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;

export function isValidSha(value: string | undefined | null): value is string {
  return typeof value === "string" && FULL_SHA_PATTERN.test(value);
}

export type SourceIntegrityStatus = "CURRENT" | "STALE" | "MISSING" | "UNKNOWN";

/** What's actually stored in R2 right now for the shadow source archive - the "current-meta" pointer
 * object, plus a separately-checked flag for whether the archive bytes it points at still exist (a
 * pointer can outlive its target if an upload is interrupted after the meta write but before... actually
 * meta is written LAST, see validation-worker.ts's shadowSourceUpload, but a manual R2 object deletion or
 * bucket-level mistake is still worth detecting rather than crashing the poll with an opaque error). */
export interface SourceArchiveMeta {
  sourceSha: string;
  archiveHash: string;
  archiveKey: string;
  uploadedAt: string;
  sizeBytes: number;
  label?: string;
}

export interface SourceIntegrityResult {
  status: SourceIntegrityStatus;
  /** What the deployed Worker itself expects (env.EXPECTED_SOURCE_SHA) - undefined when the Worker was
   * deployed without stamping it (a misconfigured/legacy deploy, not a normal state). */
  expectedSha?: string;
  /** What the R2 pointer actually names, if the pointer exists and is well-formed. */
  archiveSha?: string;
  archiveHash?: string;
  uploadedAt?: string;
  /** Human-readable explanation - always present, always safe to surface verbatim in an API response or
   * log line (never includes secrets; the values involved are commit SHAs and timestamps only). */
  detail: string;
}

/**
 * The one function every autonomous entry point (shadow-cron.ts, the webhook's push-triggered poll, and
 * GET /v1/shadow/cron-status) calls to decide source integrity - a single source of truth so the gate
 * that blocks a stale poll and the status endpoint that reports on it can never drift apart from each
 * other the way the two were never actually connected before this fix.
 *
 * Deliberately conservative: any input that isn't a clean, matching pair of full SHAs resolves to a
 * non-CURRENT status. There is no "probably fine" outcome.
 */
export function computeSourceIntegrity(
  expectedSha: string | undefined,
  meta: SourceArchiveMeta | undefined,
  archiveBytesExist: boolean,
): SourceIntegrityResult {
  const expected = isValidSha(expectedSha) ? expectedSha : undefined;
  const archiveSha = meta && isValidSha(meta.sourceSha) ? meta.sourceSha : undefined;
  const common = { expectedSha: expected, archiveSha, archiveHash: meta?.archiveHash, uploadedAt: meta?.uploadedAt };

  if (!expected) {
    return {
      ...common,
      status: "UNKNOWN",
      detail: expectedSha
        ? `deployed Worker's EXPECTED_SOURCE_SHA ("${expectedSha}") is not a valid full git SHA - redeploy with npm run shadow:deploy`
        : "deployed Worker has no EXPECTED_SOURCE_SHA configured - redeploy with npm run shadow:deploy (never falls back to trusting whatever archive happens to be in R2)",
    };
  }
  if (!meta) {
    return { ...common, status: "MISSING", detail: "no source archive has ever been uploaded - run npm run shadow:deploy" };
  }
  if (!archiveSha) {
    return { ...common, status: "MISSING", detail: `stored source metadata is missing or has a malformed sourceSha ("${meta.sourceSha}") - re-upload with npm run shadow:deploy` };
  }
  if (!archiveBytesExist) {
    return { ...common, status: "MISSING", detail: `source metadata points at "${meta.archiveKey}" but no archive object exists there - re-upload with npm run shadow:deploy` };
  }
  if (archiveSha !== expected) {
    return { ...common, status: "STALE", detail: `deployed Worker expects source ${expected} but the uploaded archive is ${archiveSha} - run npm run shadow:deploy to bring them back in sync` };
  }
  return { ...common, status: "CURRENT", detail: `source archive matches the deployed Worker's expected SHA (${expected})` };
}

/** True only for the one status that may proceed to an actual analysis. Named separately (rather than
 * inlining `=== "CURRENT"` at every call site) so every caller reads the same intent and a future status
 * value added to the enum can't accidentally be treated as safe by a call site that forgot to update. */
export function sourceIsUsable(result: SourceIntegrityResult): result is SourceIntegrityResult & { status: "CURRENT"; archiveSha: string } {
  return result.status === "CURRENT";
}
