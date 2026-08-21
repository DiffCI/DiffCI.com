# Shadow source-version integrity fix

Companion: [`docs/CURRENT_STATE.md`](../CURRENT_STATE.md) (the snapshot that caught the underlying bug),
[`2026-08-21-stage2-architecture.md`](2026-08-21-stage2-architecture.md) (Phase 5/6/7/8 - the pipeline this
fix hardens).

## The bug

`docs/CURRENT_STATE.md` (written earlier the same day) found, by directly querying the deployed Worker,
that the autonomous shadow-cron's source archive in R2 was stamped `e58fdfb` while `main` had moved 4
commits past it, to `d65b214`. The mechanism: `scripts/upload-shadow-source.ts` had to be run manually
after any `src/` change for the cron to pick it up, and nothing ever checked whether that had actually
happened. The Worker, the D1-backed cron audit trail, and every prediction the cron recorded were all
"healthy" by every existing signal - no error, no failed run, no gap in `shadow_cron_runs` - while silently
analyzing every enrolled repository (including this one, observing itself) with an old implementation.
Nothing would have surfaced this on its own; it was only caught by manually cross-referencing the R2
metadata's label against `git log`.

Compounding it: the `diffciAnalysisVersion`/`graphVersion` fields already threaded through the prediction
pipeline (`src/shadow/event-identity.ts`) were never a real version identity in the first place -
`cloudflare-shadow-poll.ts` defaulted them to the static literal `"stage2-shadow-poll-1"`, and
`execShadowPoll` never passed `--diffci-version`/`--graph-version` at all. There was no field anywhere that
actually named the git commit that produced a given prediction.

## The invariant

```
expected source SHA (env.EXPECTED_SOURCE_SHA, stamped at deploy time)
    ==
archive source SHA (R2 "current-meta" pointer, from the packaged commit's real git SHA)
    ==
SHA recorded on every new prediction (shadow_predictions.engine_source_sha)
```

Any of these being absent, malformed, or mismatched resolves to a non-`CURRENT` status
(`STALE`/`MISSING`/`UNKNOWN`, see `src/research/cloudflare/shadow-source-integrity.ts`), and every
autonomous entry point (the cron's `runShadowCronOnce`, the webhook's push-triggered poll) refuses to run
an analysis under any status but `CURRENT` - it does not fall back to whatever archive happens to be
sitting in R2. The refusal is recorded as an infrastructure error (`source-integrity-STALE: ...` etc.),
distinct from any `opportunity_category` value, so it can never be misread as the impact-analysis
classifier's own `MANDATORY_FALLBACK` decision.

## What changed

- **`src/research/cloudflare/shadow-source-integrity.ts`** (new) - the pure decision logic
  (`computeSourceIntegrity`), unit-tested exhaustively. The one function every caller (the cron gate, the
  webhook gate, `GET /v1/shadow/cron-status`) shares, so the thing that blocks a stale poll and the thing
  that reports on it can never drift apart.
- **R2 layout**: the archive itself now lives at an immutable, content-addressed
  `shadow/source/by-sha/<sourceSha>.tgz` (never overwritten - a same-SHA re-upload is verified
  byte-identical via a recomputed SHA-256 `archiveHash`, or rejected as a collision), with a single mutable
  pointer object (`shadow/source/current-meta`) written LAST, after the archive bytes are durably stored.
  This is what makes two racing uploads (deploy A, deploy B) safe: whichever pointer write lands last wins
  cleanly, and it can never reference a partially-written or wrong-SHA archive, because different SHAs
  never share a key.
- **`POST /v1/shadow/source`** now requires `sourceSha` (a real 40-hex git SHA) and `archiveHash`
  (server-recomputed from the received bytes, not just trusted from the client) - malformed/missing
  metadata is rejected outright, never silently accepted.
- **`env.EXPECTED_SOURCE_SHA`** - the deployed Worker's own idea of what source SHA it expects, stamped at
  deploy time via `wrangler deploy --var EXPECTED_SOURCE_SHA:<HEAD>`, deliberately never a static value in
  `wrangler.research-sandbox.jsonc` (a checked-in SHA would itself go stale on the next commit).
- **`scripts/shadow-source-lib.ts`** (new, shared) - `currentHeadSha`/`isWorkingTreeDirty`/`packageSource`:
  the SHA always comes from `git rev-parse HEAD` on a clean tree, never a manually suppliable label
  (`upload-shadow-source.ts`'s old `--label` default was a short SHA a caller could freely override -
  `sourceSha` no longer can be).
- **`scripts/deploy-research-sandbox.ts`** (new) - the canonical pipeline: validate clean tree → typecheck
  → test → package+upload source → `wrangler deploy --var EXPECTED_SOURCE_SHA:<HEAD>` → verify
  `sourceIntegrity.status === CURRENT` with both SHAs matching HEAD, or exit non-zero. `npm run
  shadow:deploy`. Replaces "deploy the Worker, remember to also run shadow:upload-source" with one command
  that cannot silently skip the second half.
- **`shadow_predictions.engine_source_sha`** (new nullable column,
  `schema-migration-2026-08-21-shadow-source-integrity.sql`) - every prediction from the cron/webhook path
  now carries the exact commit that produced it. Threaded from the verified R2 archive's SHA →
  `execShadowPoll`'s `--engine-source-sha` → `cloudflare-shadow-poll.ts` stamps it onto each prediction →
  persisted. NULL for every pre-fix row and for any ad-hoc `POST /v1/shadow/poll` caller that doesn't
  supply one - never backfilled or guessed.
- **`shadow_cron_runs.source_integrity_status`** (new nullable column) - per-run audit trail of what the
  gate found, alongside `GET /v1/shadow/cron-status`'s new `sourceIntegrity` block (live, always-current,
  the same computation the gate itself uses).

## Database/schema changes

One additive migration, two `ALTER TABLE ... ADD COLUMN` statements, both nullable:
`schema-migration-2026-08-21-shadow-source-integrity.sql`. No existing table, row, or column is altered or
removed. Historical rows read back with `engine_source_sha`/`source_integrity_status` as `NULL` - reported
as "unknown," never backfilled with a guessed value (`tests/research/cloudflare/shadow-store.test.ts`
covers exactly this).

## Scope discipline

Per the task's explicit constraints, this change does **not**: alter planner semantics, confidence
thresholds, or the opportunity classifier; connect Planner to Runner or begin any selective enforcement;
touch the Runner Dispatcher App or its infrastructure; delete or rewrite any historical Stage 2 evidence;
or expand language support. It is scoped entirely to shadow source-version integrity and reproducibility.

## Tests

- `tests/research/cloudflare/shadow-source-integrity.test.ts` - `computeSourceIntegrity`/`isValidSha`
  exhaustively: CURRENT, STALE, MISSING (no metadata / malformed SHA / bytes gone), UNKNOWN (no expected
  SHA / malformed expected SHA), and a sweep asserting no "almost right" combination is ever CURRENT.
- `tests/research/cloudflare/shadow-cron.test.ts` - new `describe` block: CURRENT polls and threads the
  real SHA into `pollRepository`; STALE/UNKNOWN refuse to poll any due repository (never falls back);
  the refusal string is asserted to never contain `MANDATORY_FALLBACK`; a repository with an unchanged
  head never even triggers a source-integrity check; a `getVerifiedSourceArchive` throw is handled
  distinctly from a clean non-CURRENT result.
- `tests/research/cloudflare/shadow-store.test.ts` (new) - real SQLite (`node:sqlite`) backing the actual
  committed migration files (validates they apply cleanly in production order, not just that the TS
  compiles): `engine_source_sha` persists when supplied, is NULL when omitted, `getRepositorySummary`
  surfaces the latest prediction's engine SHA, a simulated pre-fix row (no `engine_source_sha` in its
  INSERT at all) remains fully readable, and `ON CONFLICT DO NOTHING` idempotency still holds.
- `tests/scripts/shadow-source-lib.test.ts` (new) - against an isolated throwaway git repo (never this
  repo's own working tree, which is routinely dirty mid-development): `currentHeadSha` matches real
  `git rev-parse HEAD`; `isWorkingTreeDirty` catches both a modified tracked file AND a genuinely untracked
  one; `packageSource` refuses a dirty tree by default and only proceeds under an explicit debug-only
  `allowDirty`; the produced `archiveHash` is verified against an independently computed SHA-256 of the
  same tarball bytes; two different commits produce two different `sourceSha`/`archiveHash` pairs.

**Full suite**: `npm run typecheck` clean; `npm run test` 336/336 passing (up from 302 before this change -
34 new tests, 0 removed or weakened).

## Live verification

See the session's final report for the actual `Repository HEAD` / `Expected Shadow SHA` / `Stored archive
SHA` / `Source integrity status` / `Deployed Worker` / `Latest prediction engine SHA` values captured
against the real deployed Worker after running `npm run shadow:deploy`.

## Remaining risks

- **`POST /v1/shadow/poll`'s ad-hoc multipart path** (caller-supplied source, predates and is independent
  of this fix) does not enforce the invariant - it now accepts an optional `sourceSha` form field and
  records it when present, but a caller who omits it gets an honestly-NULL `engine_source_sha`, not a
  rejection. This is deliberate (it is not an autonomous path), but is worth knowing if that route sees
  real use beyond manual debugging.
- **R2 is eventually consistent in the general case**; this fix's read-after-write ordering (archive bytes
  before the meta pointer) closes the main race, and `loadVerifiedShadowSource` treats a read failure after
  a passing `headExists` check as `MISSING` rather than crashing, but a very tight compound race (list vs.
  get) is not exhaustively load-tested here - only reasoned about and unit-tested at the logic layer.
- **The by-sha archive objects accumulate forever** - nothing garbage-collects old `shadow/source/by-sha/*`
  entries. At one archive per deploy this is a small, bounded cost for the foreseeable future, but a
  cleanup policy is a real future task, not something this fix addresses.
- **`wrangler deploy --var`** merging behavior with the config file's own `vars` was verified against the
  installed wrangler version's `--help` text and the deploy script's own before/after `cronEnabled`
  sanity check, but was not independently confirmed against Cloudflare's own changelog for this exact
  version - the deploy script's warning (not a hard failure) is the safety net if that assumption is ever
  wrong.
- **The D1 migration must still be applied to the real remote database by hand**
  (`wrangler d1 execute diffci-research --remote --file=...`), same as every prior migration in this
  repository - `shadow:deploy` deploys the Worker and uploads the source archive, but does not run D1
  migrations automatically (consistent with how every existing migration file in this repo already
  documents itself; not a new gap introduced here).
