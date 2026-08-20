# Stage 2 — prospective shadow validation: architecture, gap analysis, and Gate A status

Stage 0 (2,000 historical deltas, GO WITH CONDITIONS) and Stage 1B (3 targeted fixes, live coverage/safety
validation, a runtime pilot) are complete and are **not** revisited here. This document covers Stage 2:
moving DiffCI from historical/research validation to prospective, production-like validation on real,
currently-arriving CI events - while never allowing DiffCI to actually skip real CI work.

## Phase 1 — what already existed vs what had to be built

A thorough inspection (three parallel deep-reads of the graph engine/planner, the Cloudflare deployment/
persistence layer, and existing GitHub integration code) found the picture was **not** "build from
scratch." Specifically:

**Already production-quality, reused unchanged:**
- The graph engine, `ImpactAnalyzer`, `DefaultCIPlanner`, and the Stage 1B `refineConfidenceForDelta`/
  tsconfig-fallback/package.json-diffing fixes (`src/repo/graph.ts`, `src/repo/impact.ts`,
  `src/planner/planner.ts`).
- The opportunity classifier (`MANDATORY_FALLBACK` / `BASELINE_ALREADY_OPTIMAL` /
  `DISCRIMINATIVE_OPPORTUNITY`, `src/research/benchmark/opportunity-analysis.ts`) - reused verbatim, not
  redefined, per the task's explicit "do not change the classifier because live data looks different."
- The Stage 1B safety-measurement methodology (`collectHistoricalEvidenceForDelta`,
  `filterToTestCategoryTaskIds`, `checkJobFlakiness`) - this is exactly the "apply the improved safety
  methodology from Stage 1A/1B" the task asked for, and it's what Stage 2's ground-truth reconciliation is
  built on (`src/shadow/reconcile.ts`).
- The Cloudflare Sandbox Container deployment (`wrangler.research-sandbox.jsonc`, D1 + R2 + Container),
  the retry/resumability/idempotency layer (`retry.ts`, `resumable-batch.ts`, `ON CONFLICT DO NOTHING`
  idiom), and the cost/budget model - all extended, not replaced.
- **A genuinely surprising find**: `src/shadow/` already contained a substantial prospective-shaped
  pipeline (`experiment.ts`, `runner.ts`, `github-baseline.ts`, `failure-recall.ts`, `task-mapping.ts`) -
  predict-then-fetch-real-outcome, in that order, already wired as a non-gating GitHub Actions step
  (`.github/workflows/diffci-shadow.yml`) on every push/PR to this very repository. It uses local JSONL
  file persistence (not centrally queryable) and DentalPresence-specific failure matching
  (`taskIdsForStep`'s hardcoded step-name substrings), so it doesn't generalize to arbitrary third-party
  repositories - but the shape was already right, and studying it directly informed Stage 2's design
  rather than being discarded.
- **A live bug found and fixed while inspecting it**: every single historical run of that workflow (15+
  checked) had failed at GitHub Actions *startup* (empty `steps[]`, ~4s duration) because it requested
  `permissions.actions: write`, which exceeds this repo's `default_workflow_permissions: read` policy -
  neither `upload-artifact` nor a same-run `download-artifact` actually needs it. Fixed in
  `.github/workflows/diffci-shadow.yml`. Zero shadow evidence had ever actually been recorded before this
  fix.

**Did not exist at all, confirmed by exhaustive search:** any GitHub App registration/JWT/installation-
token code, any webhook receiver or signature verification, any `octokit`/`probot` dependency, and any
"event" identity model beyond a plain commit-pair key. 100% of prior GitHub interaction was DiffCI's own
outbound REST calls about already-completed commits - genuinely batch/backward-looking, never push-based.

## An unplanned but load-bearing discovery: GitHub Actions is currently billing-blocked

While verifying the shadow-workflow fix by triggering a real run, every workflow on this account
(`DiffCI Shadow Experiment`, `CodeQL`, `Deploy Cloudflare staging`) failed identically, with the real
GitHub check-run annotation: *"The job was not started because recent account payments have failed or
your spending limit needs to be increased."* This blocks **all** GitHub Actions on this account right now
- not just Stage 2's work, but real staging deploys and security scanning too. It's a billing action
outside what this assistant can or should touch; the user was notified directly and asked how to proceed.

**Decision (explicit, user-approved): use Cloudflare resources instead of depending on this account's own
GitHub Actions for Gate A.** Concretely, this means Gate A targets a real *third-party* repository (whose
own GitHub Actions is unaffected by this account's billing state), and DiffCI's own analysis runs on the
already-proven Cloudflare Sandbox Container pipeline rather than as a GitHub Actions step. This is a
genuine, load-bearing scope change from the original plan (which favored `diffci-shadow.yml` on this
repo) - not a workaround to avoid, but the more robust design for reasons below, so it's kept even after
billing is eventually resolved.

## Phase 2 — event identity model (the exact choice, and why)

Two deliberately separate keys, not one - see the full rationale in the schema file
(`schema-migration-2026-08-21-stage2-shadow.sql`) and `src/shadow/event-identity.ts`:

- **`logicalDeltaKey`** (one row per **prediction**): `repository:baseSha:headSha:diffciAnalysisVersion:
  graphVersion` - a pure function of the commit pair and DiffCI's own version. A workflow retry of the
  same commit reuses this exact row; it is never recomputed, because recomputing after possibly having
  seen a real outcome is precisely what Phase 5 forbids.
- **`logicalEventKey`** (one row per **real observed CI attempt**): `repository:headSha:
  workflowRunId:workflowRunAttempt` (using the literal string `"poll"` in place of a run id when ground
  truth came from Cloudflare-poll-discovered completed runs rather than a specific known run - see the
  schema comment for the exact substitution rule). Deliberately one row per attempt, not deduped to one
  per commit, so a flaky retry's different real outcome stays visible rather than silently overwritten -
  this is the exact identity the task specification itself suggested.
- **The prospectiveness proof**: `predictionPrecededGroundTruth()` compares the prediction's own
  `predictionCreatedAt` (written once, immutable) against the real workflow's completion timestamp (or,
  conservatively, the time ground truth was fetched when the real timestamp isn't available). This is
  computed once at ground-truth-recording time and stored, not re-derived later.

## Phase 5/6/7/8 — the prospective pipeline, as actually built

Two independent phases, run by different code paths at different times, which is what makes the
prospectiveness proof meaningful:

1. **`scripts/cloudflare-shadow-poll.ts`** (runs in a Sandbox Container - needs a real git clone and the
   TypeScript compiler API, neither available in a plain Worker): clones/updates a real target
   repository, compares current HEAD against the repository's last-seen SHA, and for any commit(s) that
   landed since, runs the real production pipeline (`runDiffCIAnalysis`) to compute a prediction -
   DiffCI's selection, PATH's selection (both test-file-level and task-level), the opportunity category,
   and analysis overhead. **On a repository's first-ever poll, this deliberately does not backfill
   predictions for pre-existing history** - it only records the current HEAD as a baseline. Predicting
   against commits whose outcome may already be knowable would not be prospective evidence, and the task's
   own "Research integrity" section forbids exactly that kind of after-the-fact reconstruction.
2. **`src/shadow/reconcile.ts`** (pure, Worker-native - just `fetch()` to GitHub's REST API, no container
   needed): given a pending prediction, calls the Stage 1B safety pipeline
   (`collectHistoricalEvidenceForDelta`) to find the real, already-completed CI outcome for that exact
   commit, classifies failures (`src/shadow/failure-classification.ts` - `TEST_FAILURE`/`BUILD_FAILURE`/
   `TYPECHECK_FAILURE`/`LINT_FAILURE`/`INFRASTRUCTURE_FAILURE`/`RATE_LIMIT`/`FLAKY_FAILURE`/
   `EXTERNAL_SERVICE`/`CONFIGURATION_FAILURE`/`UNKNOWN`, conservative - falls back to `UNKNOWN` rather
   than guessing), and computes prospective recall for both DiffCI and PATH. Returns `STILL_PENDING`
   (not an error, not a miss) when no completed CI run exists yet for that commit - never claims a recall
   number from an empty denominator.

Both are wired into the Cloudflare research Worker (`validation-worker.ts`) behind the same Bearer-token
auth as every other `/v1/*` route:

| Route | Auth | What it does |
|---|---|---|
| `POST /v1/shadow/enroll` | Bearer | Registers `{repository, observationSource}`, state `VALIDATING`. |
| `POST /v1/shadow/poll` | Bearer | Dispatches the poll script in a Container, persists any new predictions to R2 (full record) + D1 (index), advances `last_polled_sha`, transitions `VALIDATING → SHADOW_ACTIVE` on the first recorded prediction. |
| `POST /v1/shadow/reconcile` | Bearer | Finds predictions with no ground-truth row yet, attempts reconciliation for each, persists results. |
| `GET /v1/shadow/status` | Bearer | Aggregate counts for one enrolled repository. |

D1 is the fast/queryable index (`shadow_repositories`, `shadow_predictions`, `shadow_ground_truth`); R2
holds the full record for each, exactly mirroring the existing Stage 0 `completed_deltas`/R2-evidence
pattern. `ON CONFLICT DO NOTHING` everywhere for idempotency, same idiom as the rest of the codebase.

## Phase 9 — compute vs wall-clock, honestly separated

Ground truth's `computeMeasuredMetrics` (reused from the existing `src/shadow/task-mapping.ts`) reports
`retainedTaskDurationMs`/`skipCandidateDurationMs`/`netPotentialTimeSavedMs` from real, summed job/step
durations - this is **compute time**, not wall-clock. Stage 2 does not currently compute a real
critical-path/wall-clock figure (that requires knowing the job DAG's parallel structure, not just summed
durations) - this is called out explicitly as unimplemented rather than silently conflated with compute
savings, per Phase 9's explicit warning against exactly that conflation. It's a concrete, scoped next
step, not a finding.

## Phase 3/4 — GitHub App design (code ready, not registered)

Per an explicit decision with the user: this assistant designs and writes the App-integration code, but
does not register the App itself on GitHub (an outward-facing, identity-tied, persistent-integration
action). `src/shadow/github-app.ts` implements RS256 App-JWT signing, installation-token exchange, and
webhook HMAC-SHA256 verification, entirely on the Web Crypto API (no new dependency, runs identically in
Node and Workers) - tested including a real RSA sign/verify round-trip, not just structurally.

**Requested permissions (least privilege - read-only, exactly what shadow mode needs and nothing else):**

| Permission | Level | Why |
|---|---|---|
| Metadata | Read | Required baseline for any GitHub App. |
| Contents | Read | Clone/diff the repository to build the dependency graph. |
| Actions | Read | List/read workflow runs and jobs - the ground-truth source. |
| Checks | Read | Read check-run conclusions where a repository uses status checks instead of/alongside Actions jobs. |
| Pull requests | Read | PR number, base/head SHA, and metadata for the event-identity model. |

No write permission is requested anywhere - shadow mode never comments, labels, checks out branches for
writing, or modifies any repository state. **Subscribed webhook events:** `push`, `pull_request`,
`workflow_run` (needed to know when a run completes, without polling). Setup steps for whoever registers
the App: create it under Settings → Developer settings → GitHub Apps with exactly the permissions/events
above, generate a private key, convert it to PKCS#8 (`openssl pkcs8 -topk8 -nocrypt -in key.pem -out
key-pkcs8.pem` - GitHub's own download is PKCS#1, which Web Crypto's `importKey` rejects), and store the
App ID, private key, and webhook secret as Worker secrets (`wrangler secret put`). No code changes needed
beyond wiring a new webhook-receiving route to the already-written `verifyWebhookSignature`/
`exchangeInstallationToken` functions.

## Phase 14 — repository states actually used right now

`shadow_repositories.state` implements the full state enum from the spec (`INSTALLING`/`VALIDATING`/
`SHADOW_ACTIVE`/`SHADOW_LIMITED`/`PAUSED`/`UNSUPPORTED`/`READY_FOR_ENFORCEMENT_REVIEW`/`REMOVED`). Only
`VALIDATING → SHADOW_ACTIVE` (on the first successfully recorded prediction) is currently automated; every
other transition is a manual/future operation. No code path anywhere writes `READY_FOR_ENFORCEMENT_REVIEW`
automatically - see `2026-08-21-stage2-enforcement-thresholds.md` for the (pre-committed, before-results)
thresholds that would make a human consider setting it.

## Security model

- Every `/v1/shadow/*` route requires the same constant-time Bearer-token check
  (`secureTokenEqual`/`authorized`) as every other route on this Worker - no new auth mechanism
  introduced, no weakening of the existing one.
- `owner`/`name`/`language` are validated against a strict allow-list pattern
  (`validateShellSafeIdentifiers`) before ever reaching a shell command inside the Container, exactly
  matching the existing defense-in-depth already in place for the other `/v1/forensic/*` routes.
- `GITHUB_TOKEN` (optional Worker secret) is only ever passed through `exec`'s `env` option, never
  interpolated into a command string or logged - unchanged from the existing pattern.
- The GitHub App design above requests read-only permissions exclusively; webhook payloads are verified
  by HMAC-SHA256 signature before any processing (code ready, not live).
- Tenant isolation across many enrolled repositories is currently by-value only (every D1 row and R2 key
  is repository-scoped, e.g. `shadow/predictions/{repository}/{key}`) - there is no cross-repository query
  path in any route today. A real multi-tenant deployment (Gate C/D) would additionally need row-level
  access control tied to which customer/installation is asking, which does not exist yet - Gate A (2
  repositories, both public, both queried by the same operator) does not exercise this, and this is
  flagged as a real gap for Gate B+, not silently assumed solved.

## What Stage 2 does NOT do (by design, this session)

- **Does not skip, cancel, alter, or block any real CI work anywhere.** Every route above is read-only
  with respect to the target repository - clone and analyze, never write. This matches the CRITICAL
  SAFETY RULE exactly: shadow-only, full stop.
- **Does not onboard 5-10 real design-partner repositories.** No real external stakeholders were
  available in this session; Gates B/C/D (which require an actual partner team, not just a public
  repository this assistant can read) are explicitly not run - see the final Stage 2 report for what
  this means for the overall recommendation.
- **Does not build a dashboard/customer-facing report UI.** The `/v1/shadow/status` route returns the raw
  aggregate JSON a future dashboard would render; no UI exists.
- **Does not compute dollar-cost economics.** With ground-truth volume currently at zero real
  reconciliations, any dollar figure would be fabricated. Phase 10's economics work is deferred until
  real volume exists, per the enforcement-thresholds doc's own volume floor.
- **Does not implement autonomous (Cron Trigger) polling yet.** `/v1/shadow/poll` currently requires the
  diffci source tarball as a multipart upload per call (the same pattern every other `/v1/forensic/*`
  route already uses), which a Cloudflare Cron Trigger cannot supply directly. The concrete next step is
  persisting the source tarball once in R2 and having a `scheduled()` handler read it back - a small,
  well-scoped addition, not built in this session because Gate A's live verification only needed a few
  manually-dispatched polls to prove the pipeline itself works end-to-end.

## Gate A status as of this writing

Two real repositories enrolled (`unjs/defu`, `unjs/unstorage` - chosen for size/activity diversity: defu
is tiny and low-commit-volume, unstorage is larger and was actively committing within hours of
enrollment). Both have a real, verified baseline poll (`firstPoll: true`, real current HEAD SHA recorded,
zero predictions - correct, expected behavior for a first poll per the design above). A second poll of
`unjs/unstorage` after real elapsed time found no new commits yet (`predictionsRecorded: 0`, same
`newHeadSha` as before) - the pipeline is correctly idle, not broken; a real prediction will be recorded
automatically the next time this route is dispatched after a genuine new commit lands. See the final
Stage 2 report for what this does and does not allow concluding yet.
