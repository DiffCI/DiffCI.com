# 2026-09-05 — Own-repo shadow telemetry: prediction healthy, ground truth stalled and invalid, economics unobservable

**Status:** diagnosed 2026-09-05 by a read-only investigation: every D1 statement was a `SELECT`,
every GitHub call a `GET`, every R2 access a `get`; no Worker was redeployed, no row was written, no
routine was created or changed. The founder's review (same day) fixed the repair order and the evidence
standard recorded in "Decisions" below. **Repair step 1 (F1, reconciler head-of-line block) is
implemented - see "Fix 1" at the end.** Steps 2-4 are not.

**One-line state:** shadow prediction generation → healthy · ground-truth collection → invalid on
DentalPresence.in, stalled on DiffCI.com since 2026-08-23 · economics → structurally unobservable on
both. **The current shadow data must not be read as evidence that prediction or selection has
degraded.** The measurement pipeline is broken in several distinct places; the selector is not the thing
that changed.

## Symptom

A routine telemetry review of the two own-repo installs (`adityankale190895/DiffCI.com`,
`adityankale190895/DentalPresence.in`, both `github-app-webhook`, both `SHADOW_ACTIVE`) the day after
the push-poll queue fix (`docs/research/2026-09-04-shadow-push-poll-lifetime.md`). Predictions were
arriving for both repositories through the new queue path, so the pipeline looked healthy at the
`/v1/shadow/status` level. It was not.

## Headline numbers (D1 `diffci-research`, 2026-09-05T03:20Z)

| | DiffCI.com | DentalPresence.in |
|---|---:|---:|
| Predictions | 324 | 26 |
| Ground-truth rows | 65 (last created **2026-08-23**) | 23 |
| Pending, `last_reconcile_attempted_at IS NULL` | **249** | 0 |
| Pending, `no_matching_workflow` (permanent) | 10 | 3 |
| Evaluable CI failures preserved by DiffCI | 17 / 17 | 0 / 0 |
| `prediction_preceded_ground_truth = 1` | 62 / 65 | **0 / 23** |
| Economics rows with `avoidable_tier = ESTIMATED` | 0 / 96 | 0 / 28 |
| `plan_mode = FULL` | 82 / 324 | 13 / 26 |
| Push polls since the queue fix (`shadow_push_polls`, kind `poll`) | 3 succeeded | 6 succeeded |

`GET /v1/shadow/reconcile-diagnostics?repository=adityankale190895/DiffCI.com` reported the same thing
live: `pendingReasons: [{not_yet_attempted: 249}, {no_matching_workflow: 10}]`, `oldestPendingAgeMs`
≈ 13.9 days. The endpoint was right; nothing was reading it.

## Findings

### F1. Reconciler head-of-line blocking (DiffCI.com ground truth frozen since 2026-08-23)

`findPendingPredictions` (`src/research/cloudflare/shadow-store.ts`) selects pending predictions with
`ORDER BY p.created_at ASC LIMIT ?` and the cron passes `reconcileLimitPerRepo = 10`
(`src/research/cloudflare/shadow-cron.ts`). Nothing excludes rows that can never resolve.

DiffCI.com has exactly ten predictions whose head commit never had a workflow run: intermediate commits
of multi-commit pushes (GitHub runs CI for the push head only). Verified against GitHub, not inferred:
`/actions/runs?head_sha=066bba4c…`, `…=a208b94d…` both return `total_count: 0`. Their
`prediction_created_at` values are 2026-08-22 (4 rows) and 2026-08-26 (6 rows). From the moment the
tenth appeared, every 10-minute cron tick re-attempted those same ten rows, recorded
`no_matching_workflow` again, and never reached anything newer. All 249 predictions created from
2026-08-27 onwards have `last_reconcile_attempted_at IS NULL`.

DentalPresence.in has three such rows (two from 2026-08-21, one from 2026-09-04: `c0684f4e`, the middle
commit of a two-commit push). It still reconciles only because 3 < 10.

### F2. DiffCI.com's own CI has been dead since 2026-09-03T03:38Z (runner workstream, not selector)

`ci.yml` and `diffci-observe.yml` run on `[self-hosted, cloudflare]` (the `diffci-github-runner`
Worker and its separate write-scoped App). From the GitHub Actions API on 2026-09-05:

| Fact | Source |
|---|---|
| Last CI run picked up promptly: `39412bfd` at 2026-09-03T03:25Z, `success` | `/actions/runs` |
| First stranded run: `e8cc81b2` at 03:38Z, `cancelled` after exactly 24 h | same |
| 36 `CI` runs on `main` cancelled with "The job has exceeded the maximum execution time while awaiting a runner for 24h0m0s" | `gh run view` annotation |
| 6 runs still `queued` (pushes `95edf28`, `e551881`, `c83e30f` × CI + observation), 14+ h old | `/actions/runs?status=queued` |
| Registered runners for the repository: **0** | `/actions/runners` |
| `db903b01`'s CI ran at 2026-09-04T13:08Z after **23 h 47 min** in queue, on `cf-job-101034132786` — a runner started for a *later* push's job that claimed the oldest queued job instead | `/actions/runs/33760638863/jobs` |
| Runner App's last 15 `workflow_job` deliveries (16:19Z–17:44Z, 2026-09-04) are all repository `1277917145` (DentalPresence.in); none for DiffCI.com (`1340874432`) | `runner.diffci.com/app-info` |
| `runner.diffci.com/app-info?delivery=fleet:…` itself returns Cloudflare error 1101 (unhandled Worker exception) | direct GET, twice |

`docs/CURRENT_STATE.md` §5's "Status: green, steady-state verified" was true when written and is not
true now. Consequence for measurement: even after F1 is fixed, the Sep 3–4 DiffCI.com predictions will
reconcile against `cancelled` runs. Those rows must keep infrastructure/cancellation provenance and
must not become apparent selector outcomes.

The shadow-poll container `npm ci` timeouts cluster on the same days (2026-09-03 22:10–23:10Z on
unstorage/nitro/nuxt/h3, 2026-09-04 08:00–08:30Z astro, 10:50Z nitro, 11:10Z DentalPresence). Same
Cloudflare Containers platform; a correlation only, not established as a common cause.

### F3. DentalPresence.in ground truth carries no test signal (23 rows contaminated)

DentalPresence.in's workflows are `CodeQL` and `Deploy Cloudflare staging` (tests run inside the job
named "Build and deploy exact commit to Cloudflare"; typecheck/lint in "Typecheck, lint, and
portability"). There is no workflow whose identity is "the test run".

`reconcilePrediction` (`src/shadow/reconcile.ts`) marks a commit `COMPLETE` as soon as
`fetchBaselineEvidence` finds **any** completed non-shadow run, and takes `workflowRunId` from
`fullRunsObserved[0]`. CodeQL's run is `skipped` within a second of every push. Worked example,
commit `f13d7502` (2026-09-04):

| Event | Time (UTC) |
|---|---|
| Push; CodeQL run 33901025906 created and `skipped` | 17:31:24–25 |
| Prediction written (FULL, 390/390) | 17:32:00 |
| Ground truth fetched and stored `COMPLETE` against run 33901025906 (CodeQL, `skipped`); R2 record's `fullRunsObserved` lists only that run, `jobs = [["Analyze (${{ matrix.language }})","skipped"]]`, `measured = {}` | 17:40 |
| `Deploy Cloudflare staging` run 33901025954 actually completes (`success`) | 17:44:29 |

Every one of the 23 DentalPresence.in ground-truth rows follows this shape. The 18 rows with
`workflow_conclusion = 'failure'` from 2026-08-21 are CodeQL failures and deploy-`skipped` runs
(resolved by run id against GitHub), not test failures. `prediction_preceded_ground_truth` is 0 on all
23 because the "ground truth" completed before the prediction — the CodeQL skip did, the deploy did
not. **Treat all 23 as contaminated, not as valid ground truth.**

### F4. Economics are `UNKNOWN` for both repositories because of job names

`classifyJobStage` (`src/shadow/stage-classification.ts`) buckets by substring on the job name and
only a match on `test|tests|unit|spec|vitest|jest` yields the `test` stage. DiffCI.com's single job is
named `check` → `other` (95 of 96 rows). DentalPresence.in's tests run inside "Build and deploy …" →
`build`. Neither repository can produce a `test` bucket, so `avoidable_tier` is `UNKNOWN` on every row
and "0 estimated savings" says nothing about actual savings.

### F5. Fallback profile on DiffCI.com (selector is behaving as specified)

Of 82 `FULL` predictions, classified locally by re-diffing each `base_sha..head_sha`:

| Cause | Predictions |
|---|---:|
| Global rules only (package.json / lockfile / tsconfig / `.github/`) | 48 |
| `UNKNOWN_FILE` only | 31 |
| Other (not classified here) | 3 |

Unknown-file counts by extension across those 31: `.html` 43 (site pages), `.sql` 15 (schema
migrations under `src/**/cloudflare/`, outside the `database/`-root rule), `.pdf` 12, plus one each of
`.csv`, `.yaml`, `.gitignore`, `.gitattributes`. Example: `f85cf10` changed one script and one PDF and
forced all 198 tests (R2 record: `fallbackReasons: ["Unknown changed file: site/research/2026/diffci-open-evidence-2026.pdf"]`).
Safety cross-check: all 34 deltas touching `package.json` or `package-lock.json` went `FULL` (0
exceptions). This is a product-precision observation, not a defect.

### F6. The Stage 2F daily observation routine no longer exists

Routine `trig_01AZTyUSfZcHtMMxvaKMAFoC` returns 404 and has no run sessions.
`docs/research/stage2f-observation-log.md` holds only the Day 1 (2026-08-22) and Day 3 (2026-08-23,
failed) entries. `gate_e_eligible_at` (2026-09-04T03:10Z) passed with no automated snapshot after
2026-08-23. Gate E is **not** satisfied by elapsed time alone.

### What is working

- The 2026-09-04 queue path: 9 push polls across both repositories, all `succeeded`, 40–100 s
  enqueue-to-finish, cursors advanced, `shadow_push_polls` trail intact. Deployment `FRESH` at
  `c83e30f` (`npm run shadow:freshness`), source integrity `CURRENT`.
- Selection on `DISCRIMINATIVE_OPPORTUNITY` commits: mean 2.9 tests selected of 146 (DiffCI.com) and
  2.8 of 362 (DentalPresence.in), against path-baseline means of 141 and 153.
- All 17 evaluable failures that were reconciled (2026-08-21/23, DiffCI.com) were preserved.

## What NOT to conclude

- **Not** "selection safety is proven": the 17/17 sample is conditioned on a reconciler that stopped
  working normally on 2026-08-23, and DentalPresence.in contributes zero usable test ground truth.
  Under the evidence standard of the external experiments this stays "encouraging", not a claim.
- **Not** "savings are zero": economics are unobservable (F4), not measured at zero.
- **Not** "the selector regressed": every broken part is measurement — reconciliation order, workflow
  attribution, stage classification, runner availability.
- **Not** "Gate E passed": see F6.

## Decisions (founder review, 2026-09-05)

Fix measurement integrity before interpreting any further shadow results. Order:

1. **Reconciler head-of-line block** (F1) — highest leverage. Do not silently discard the impossible
   rows: terminalise them with an explicit reason (e.g. `NO_MATCHING_WORKFLOW`) so "prediction made"
   stays distinct from "ground truth unavailable".
2. **Workflow identity** (F3) before bulk-reconciling DentalPresence.in. Require an explicitly
   identified primary/evidence workflow per repository rather than "first non-shadow workflow to
   complete". The existing 23 DentalPresence.in rows are contaminated, not valid.
3. **Stage classifier** (F4). Substring matching on `test` is too brittle; prefer explicit repository
   configuration plus conservative inference.
4. **Runner** (F2) separately. Never mix runner reliability with selector correctness; the Sep 3–4
   DiffCI.com cohort keeps its cancellation provenance.

Then run a small known cohort end-to-end through shadow telemetry and verify the resulting D1/R2
evidence by hand. Only after that does the observation clock restart; **Stage 2F is not restarted
now.** Future shadow reports keep the external-experiment discipline: FULL vs path-rule comparator vs
direct-only vs DiffCI, with prospective prediction, valid ground truth, detection outcome, and
CPU/work economics reported separately.

**Telemetry self-health invariants to add** (this incident should have been loud two weeks earlier):
fail health when `oldest_unattempted_prediction_age` exceeds a threshold; when the same pending rows
occupy the reconciliation window on consecutive runs; when predictions keep increasing while the
ground-truth count does not; when a supposedly evaluable repository yields zero classified test work
for N consecutive observations.

## Method and provenance

- D1 via `wrangler d1 execute diffci-research --remote --json` (SELECT only); live endpoints
  `/v1/shadow/cron-status`, `/v1/shadow/reconcile-diagnostics`, `runner.diffci.com/app-info`; GitHub
  REST via `gh api` (runs, jobs, runners, workflows, billing usage); R2 records
  `shadow/predictions/…` and `shadow/ground-truth/…` via `wrangler r2 object get`.
- Local cross-checks (`git diff --name-only base head` per prediction) ran against this repository's
  own history; no engine code was executed.
- One CLI detail worth keeping: `wrangler r2 object get` under Git Bash needs `MSYS_NO_PATHCONV=1`
  or the colon-bearing keys are mangled and report "key does not exist".

## Fix 1 (F1) — reconciler head-of-line block, 2026-09-05

Two halves, both in the same commit; migration
`src/research/cloudflare/schema-migration-2026-09-05-shadow-reconcile-terminal.sql`.

**Fair pending window.** `findPendingPredictions` now orders never-attempted rows first, then least
recently attempted (`last_reconcile_attempted_at`), then creation time - instead of oldest first. With
`reconcileLimitPerRepo = 10` and a 10-minute cron, every pending row of a repository is attempted at
least once per `ceil(pending / 10)` ticks whatever any other row's reason is. No reason can monopolise
the window again, terminal or not.

**Explicit terminal state, never silent.** Three additive columns on `shadow_predictions`:
`reconcile_terminal_reason` (NULL = normal; today only `NO_MATCHING_WORKFLOW`),
`reconcile_terminal_at`, `reconcile_terminal_detail` (JSON audit of the evidence). A terminal row is
excluded from the pending window and reported under reconcile-diagnostics' `terminalUnevaluable`
(the field reserved for this on 2026-08-21) with a `terminalReasons` breakdown - never under
`pending`, never as ground truth, and the prediction row itself is untouched. "Prediction made" and
"ground truth unavailable" stay two distinct facts. `terminalizePrediction` refuses when a ground-truth
row exists or the row is already terminal. Reversible by a data change (NULL the three columns).

**Decision rules** (`src/research/cloudflare/shadow-reconcile-terminal.ts`, all required; age alone
never decides, per Task 2 §11):

1. this attempt classified the row `no_matching_workflow`;
2. a previous attempt did too (two independent observations, because `classifyPendingReason`
   degrades a transient GitHub error to the same label; no minimum spacing - a repository with fewer
   pending rows than the window is re-attempted every tick, so a spacing rule would silently never
   fire there, and rule 5 is what actually excludes a transient error);
3. the prediction is at least 6 h old;
4. the repository's observed head has moved past the commit (a current head with no run at all is a
   different situation - Actions disabled, billing, an outage - and stays visible as pending);
5. a fresh, direct `GET /actions/runs?head_sha=<sha>` answered HTTP 200 with zero runs of any status.

Rule 5 is one extra GitHub call per genuine candidate and none on the ordinary pending path; any
failure there is "not confirmed" and the row stays pending (the safe direction). The manual
`POST /v1/shadow/reconcile` response and the cron's per-repository result gain a `terminalized` count.

**Verification:** `npm run check` - typecheck clean, 2009/2009 tests, including the regression shape
(ten attempted-every-sweep rows plus one fresh row: the fresh row is first in the window), the
refusal cases, and every blocking rule.

**Live verification, 2026-09-05T03:52–04:05Z.** Commits `1c1eae0` (fix) and `b163a83` (removed a
minimum spacing between the two observations, which a small backlog re-attempted every tick could
never satisfy); migration applied to remote `diffci-research`; deployed via `npm run shadow:deploy`,
`sourceIntegrity: CURRENT` at `b163a83`. Then one manual `POST /v1/shadow/reconcile` per repository:

| | DentalPresence.in (limit 10) | DiffCI.com (limit 25) |
|---|---:|---:|
| attempted | 4 | 25 |
| reconciled | 1 | 25 |
| terminalized | **3** | 0 |
| stillPending | 3 (the same 3, before their terminal write) | 0 |

The three DentalPresence.in rows carry `reconcile_terminal_reason = NO_MATCHING_WORKFLOW` and a
detail payload naming the previous attempt, the superseding head (`84b00baa`) and
`workflowRunsForHeadSha: 0` from the direct GitHub query; their prediction rows are otherwise unchanged
and their R2 evidence keys resolve. `reconcile-diagnostics` for the repository now reads
`pending: 0, terminalUnevaluable: 3, terminalReasons: [{NO_MATCHING_WORKFLOW: 3}]`. DiffCI.com's
window contained never-attempted rows for the first time since 2026-08-26: after the manual call and
the next cron tick, `reconciled` had gone from 65 to 108 (43 new rows, all `success`, predictions
dated 2026-08-26 to 2026-08-30, 29 of 43 prospective), `not_yet_attempted` from 249 to 196, and
`no_matching_workflow` from 10 to 23 - thirteen more intermediate commits surfaced in the newly
attempted range. Each of those 23 will be terminalised on its second attempt once the rotation
returns to it (about 20 ticks), without any manual step.

**Caveat carried forward to step 2.** The fair window will reach DiffCI.com's 2026-09-03/04 cohort
(about 50 predictions whose CI runs were cancelled after 24 h in queue, F2) within a few hours. The
current reconciler records those as ground truth with `workflow_conclusion NULL` in D1 and
`conclusion: "cancelled"` inside the R2 record - provenance retained, but not labelled as
infrastructure. Step 2 (workflow identity) should classify a cancelled/skipped run explicitly before
those rows are counted anywhere. DentalPresence.in's F3 contamination also continues as expected: its
push at 03:54Z was polled by the queue path and "reconciled" against the CodeQL skip within a minute.

## Fix 2 (F2/F3) — workflow identity, then execution outcome, 2026-09-05

**Invariant (founder, 2026-09-05):** a GitHub workflow run is not ground truth merely because it is
associated with the predicted commit. It must first be proven to be the workflow the prediction is
about; only then is its execution outcome classified; only an executed run may enter the ground-truth
population. Repository outcome ≠ execution infrastructure outcome. Commit `8fa8524`; migration
`schema-migration-2026-09-05-shadow-evidence-workflow.sql`.

**Identity is explicit, never inferred.** `shadow_repositories.evidence_workflow_paths` holds the
repository's evidence workflow file(s), set through the bearer-gated
`GET/POST /v1/shadow/evidence-workflow` route, which validates every path against the workflows
GitHub lists for the repository. A repository without this configuration reconciles nothing: the
reconciler records `evidence_workflow_unconfigured` on every pending prediction, makes no GitHub call,
and the diagnostics show it. Configured on 2026-09-05: DiffCI.com → `.github/workflows/ci.yml`;
DentalPresence.in → `.github/workflows/cloudflare-staging-deploy.yml` (its tests run inside that
workflow; CodeQL is excluded by construction). The six `cloudflare-poll` corpus repositories are
deliberately left unconfigured pending the founder's choice - every one of them lists a `ci.yml`,
plus autofix/publish/docs/release workflows that must not be evidence.

**Execution outcome is a closed vocabulary** (`src/shadow/execution-outcome.ts`): `EXECUTED`
(success or failure - the repository's own code ran), `NOT_EXECUTED_INFRASTRUCTURE` (cancelled with no
job ever assigned a runner or a step), `CANCELLED_DURING_EXECUTION`, `SKIPPED`, `TIMED_OUT`,
`NOT_EXECUTED_OTHER`. `fetchBaselineEvidence` in identity mode lists every run for the SHA once, selects
the latest run of the evidence workflow, keeps every other workflow's run in `otherRunsObserved` as
audit, fetches only the evidence run's jobs, and classifies. Only `EXECUTED` yields evidence. A
completed evidence run that did not execute is terminal as `EVIDENCE_RUN_<outcome>` with the run id,
attempt, conclusion and its jobs' runner/step evidence in `reconcile_terminal_detail` - never a
ground-truth row. New ground-truth rows carry `evidence_workflow_path`, `workflow_run_attempt` and
`evidence_validity = 'VERIFIED'`. Legacy (no-identity) mode is unchanged for the research replay
tooling; the production reconciler never uses it.

**Existing rows are labelled, never deleted.** The migration marks every pre-existing ground-truth
row `UNVERIFIED`; `scripts/backfill-ground-truth-validity.ts` re-labels each one from GitHub's own
record of the run it was reconciled from - `VERIFIED` only when that run is the evidence workflow and
concluded success/failure, otherwise `CONTAMINATED_WORKFLOW_IDENTITY`. Applied 2026-09-05:

| | rows | VERIFIED | CONTAMINATED_WORKFLOW_IDENTITY |
|---|---:|---:|---:|
| DentalPresence.in | 26 | 0 | 26 (CodeQL failures and deploy-`skipped` runs) |
| DiffCI.com | 221 | 144 | 77 (rows whose recorded run was the self-observation workflow, `.github/workflows/diffci-observe.yml`) |

The 77 DiffCI.com rows are a second identity contamination this fix surfaced: the legacy
`SHADOW_WORKFLOW_PATH` constant excluded `diffci-shadow.yml`, but this repository's observation
workflow is `diffci-observe.yml`, so its run was never excluded - it was recorded as the ground-truth
run on 77 rows and its "Observe this repository" job was merged into the CI evidence (which is also
why every DiffCI.com economics row landed in the `other` stage). Whether to re-derive those 77 rows
under identity mode (delete + re-reconcile) is a founder decision; they are kept and labelled.

**Live verification, 2026-09-05T05:41–06:00Z.** Deployed at `8fa8524`, `sourceIntegrity: CURRENT`.
Between the migration and the deploy the old Worker wrote 19 rows without a label; corrected to
`UNVERIFIED` by hand before the backfill. Manual reconciles after configuring both repositories:

| call | attempted | reconciled | terminalized |
|---|---:|---:|---:|
| DiffCI.com, limit 25 (Sep 1–3 pre-outage rows) | 25 | 25, all `VERIFIED` on `ci.yml`, `success` | 0 |
| DiffCI.com, limit 10 (into the Sep 3 cohort) | 10 | 3 (03:04–03:25Z, before the runner died) | **7 × `EVIDENCE_RUN_NOT_EXECUTED_INFRASTRUCTURE`** |

Each of the seven carries e.g. `{"workflowRunId":33712077088,"conclusion":"cancelled",
"executionOutcome":"NOT_EXECUTED_INFRASTRUCTURE","jobs":[{"name":"check","conclusion":"cancelled",
"runnerName":null,"steps":0}]}` - the cohort keeps its infrastructure provenance and never became a
selector outcome. The remaining ~40 cohort rows drain through the cron under the same rule. Step 1's
`NO_MATCHING_WORKFLOW` terminalisation also fired on its own during the window on nuxt (2), nitro
(5) and unstorage (2) - before those repositories became unconfigured-and-held under step 2.

**Founder decisions on Fix 2 (2026-09-05).** Steps 1 and 2 are **CLOSED / PRODUCTION-VERIFIED** at
`54122be`; historical contamination is **PRESERVED / EXCLUDED, not rewritten**.

- *Corpus workflows:* the six `cloudflare-poll` repositories stay `evidence_workflow_unconfigured`
  until each workflow is mechanically verified against the repository's actual test/evidence
  execution. Bulk-configuring them because each has a `ci.yml` would weaken the invariant from
  "explicitly identified evidence workflow" to "file named ci.yml" - exactly the inference step 2
  exists to eliminate.
- *The 77 contaminated DiffCI.com rows:* immutable as `CONTAMINATED_WORKFLOW_IDENTITY`, excluded
  from every claim, never deleted or reconciled in place. If corrected historical coverage is ever
  needed, it is a separate, clearly-marked retrospective dataset linked to the original prediction -
  both records survive, history is not rewritten.
- *The migration/deploy race* (19 rows written unlabelled between the schema migration and the
  Worker deploy) is an operational finding in its own right: schema migration and application rollout
  create a mixed-version evidence window. It is now a self-health invariant
  (`unlabelledGroundTruthRows`, Fix 3) rather than a manual clean-up.
- What step 2 proves: *ground truth is admitted only when workflow identity is explicitly configured
  and GitHub execution evidence shows the identified workflow actually executed; non-execution and
  identity contamination remain provenance, not ground truth.* `VERIFIED` establishes the
  identity/execution admission boundary only - it does not yet say what work occurred inside the run
  (that is step 3). The 17/17 preserved failures surviving the boundary is preservation of existing
  evidence, not new independent validation. DiffCI.com 254 raw → 177 verified and DentalPresence.in
  26 raw → 0 verified is a major correction to what the telemetry can legitimately support, and zero
  trustworthy observations are better than 26 attributed to the wrong workflow.

## Fix 3 (F4) — stage classification on admitted evidence only, 2026-09-05

Commit `dd4b056` (+ `48ffc53` for this repository's own CI); migration
`schema-migration-2026-09-05-shadow-stage-economics.sql`. Consumes only `VERIFIED` evidence from the
point of admission - contaminated and unverified rows never reach the classifier, rather than being
filtered from its output.

**Three faults in the legacy economics path, each fixed structurally.** (1) *No identity:* the legacy
sweep re-fetched "any completed run" and merged every workflow's jobs; the new sweep
(`shadow-stage-economics-job.ts`) reads the VERIFIED ground-truth row's evidence run and fetches THAT
run's jobs by id, nothing else. (2) *No admission:* predictions with contaminated or no ground truth
were measured; the new sweep's only input is `ShadowReadBoundary.listVerifiedGroundTruth`. (3) *A
substring classifier:* replaced by explicit per-repository configuration
(`src/shadow/stage-classification-config.ts`, set through the bearer-gated
`GET/POST /v1/shadow/stage-classification`, whose GET shows the latest verified run's real job and
step names with durations so rules are written against names that exist). Rules match job and step
names exactly; a step rule attributes that step's own measured duration, a job rule the job's
remainder; a configured repository's unmatched work is `other`/`unclassified`, never inferred.
Conservative inference (exactly one stage keyword) applies only where no configuration exists.
`inseparable` marks work that cannot be separated from non-stage work (one `npm run check` step that
typechecks AND tests; `npm ci && npm test` in one step): the measurement is kept with its basis, and
no avoidable-work estimate is derived from it (`estimation_method = 'inseparable_workload'`).

**Storage and reports.** New table `shadow_stage_economics` with full provenance per row: evidence run
id, workflow path, `classification_basis`, classifier version, job ids, step refs. The legacy
`shadow_economics_observations` (652 rows) is labelled `LEGACY_UNVERIFIED`, no longer written, no
longer read; its sweep and recompute are unscheduled. `scripts/generate-shadow-report.ts` reads the
new table only and counts safety over VERIFIED ground truth only. The status summary's recall
figures are computed over VERIFIED rows only (`groundTruthVerified` beside the raw count).

**Configuration applied 2026-09-05** (against the observed names):

| Repository | Rule | Stage | Basis |
|---|---|---|---|
| DiffCI.com | step `check :: Run npm run check` | test | inseparable (typecheck + test in one step, until `48ffc53`) |
| DiffCI.com | step `check :: Typecheck` / `check :: Test` | typecheck / test | separable (runs after `48ffc53` split the step) |
| DiffCI.com | job `check` remainder (setup, checkout, `npm ci`) | other | explicit |
| DentalPresence.in | step `Typecheck, lint, and portability :: Run checks` | typecheck | inseparable (typecheck + lint + link/route checks) |
| DentalPresence.in | step `Build and deploy … :: Install and test` | test | inseparable (`npm ci` + `npm test` in one step) |
| DentalPresence.in | steps `… :: Validate Cloudflare deployment plan`, `… :: Deploy Cloudflare staging` | build | separable (no `deploy` stage exists in the vocabulary; "Build and deploy" is the job) |
| DentalPresence.in | both jobs' remainders | other | explicit |

**Live verification, first cron tick after deploy (2026-09-05T07:00Z, 10 admitted predictions,
round-robin: 9 DiffCI.com + 1 DentalPresence.in):**

| Repository | stage | basis | rows | measured ms | avoidable |
|---|---|---|---:|---:|---|
| DiffCI.com | test | explicit_step_inseparable | 9 | 1,402,000 | UNKNOWN (inseparable, by design) |
| DiffCI.com | other | explicit_job | 9 | 187,000 | UNKNOWN |
| DentalPresence.in | test | explicit_step_inseparable | 1 | 147,000 | UNKNOWN (inseparable) |
| DentalPresence.in | build | explicit_step | 1 | 437,000 | UNKNOWN (no selection concept) |
| DentalPresence.in | typecheck | explicit_step_inseparable | 1 | 51,000 | UNKNOWN |
| DentalPresence.in | other | explicit_job | 1 | 54,000 | UNKNOWN |

For the first time both repositories carry a `test` stage with a real measured duration - and for the
first time the absence of an avoidable-work estimate has an explicit, correct reason (the work is
inseparable) instead of a substring miss. The remaining ~170 verified DiffCI.com rows drain at 10 per
tick. An ESTIMATED test-stage figure for DiffCI.com becomes possible only for runs after `48ffc53`,
which requires the runner (step 4) to execute them.

**Self-health invariants (on `GET /v1/shadow/cron-status` → `selfHealth`):** never-attempted
predictions and the oldest one's age; unlabelled ground-truth rows (the migration/deploy window);
verified rows awaiting stage economics; repositories with no evidence workflow; observed repositories
with predictions but no verified ground truth. First live reading: `neverAttempted 0`, `unlabelled 0`,
`verifiedWithoutStageEconomics 179`, unconfigured = the five active corpus repositories, and the four
corpus repositories with predictions but nothing verified.

**Runner observation during the window (step 4, not touched):** three DiffCI.com CI runs did
complete today (`c83e30f0` after ~15 h, `d0b0eb90` after 2.5 h, `1c1eae00` after 3 h) - each new push
spawns a runner that claims the OLDEST queued job - while 8 runs remain queued and 0 runners are
registered. The step-4 repair is unchanged: make the runner reliable and make it claim its own job.

**Still open after Fix 3:** step 4 (runner); corpus evidence workflows (mechanical verification, not
`ci.yml` by name); a retrospective dataset for the 77 contaminated rows if ever wanted; a manual
trigger for the stage sweep (today it runs only from the cron tick).

## Freeze (founder, 2026-09-05)

| Step | State |
|---|---|
| 1 — reconciliation fairness + explicit terminal unevaluable | **CLOSED / PRODUCTION-VERIFIED @ `b163a83`** |
| 2 — explicit workflow identity + execution-outcome admission + historical validity labelling | **CLOSED / PRODUCTION-VERIFIED @ `54122be`** |
| 3 — stage classification on admitted evidence, separate economics dataset, report | **CLOSED / PRODUCTION-VERIFIED @ `8d0f365`** |
| Historical contamination | **PRESERVED / EXCLUDED**, not rewritten |
| 4 — runner lifecycle / independent forward progress | **CLOSED / PRODUCTION-VERIFIED @ `70e3dda`** (qualified by commits `70e3dda` and `f63d139`, see Fix 4) |

What steps 1–3 establish is a clean evidence chain: *prediction → VERIFIED ground truth → identified
evidence run → actual jobs/steps → explicit stage classification → separate economics dataset →
report*. `UNKNOWN` is now a meaningful result, not missing functionality. The economics statement to
carry until step 4 produces separable observations: **test-stage work is now measured and correctly
classified, but avoidable test-stage work remains UNKNOWN where execution is inseparable.**

Not to be done before step 4: manual stage-sweep trigger (operational, not correctness-critical);
corpus repository configuration (a later, bounded qualification exercise - configuration requires
mechanical verification).

**Step 4 success condition (founder).** Not "the runner starts jobs again". Required: *for a
controlled new commit, the intended evidence workflow progresses from queued → runner assigned →
executing → terminal without requiring a subsequent push or any other unrelated repository event* -
and it must repeat: at least **two consecutive fresh commits** execute without either needing another
push to release it; if either stalls, the qualification sequence resets. Provenance must distinguish
`workflow queued → runner requested → runner registered/online → job assigned → execution started →
execution completed → runner disposition`, so a future failure is attributable to GitHub scheduling,
runner provisioning, registration, assignment, execution, or teardown rather than "runner failed".
The eight already-queued runs are incident evidence, contaminated by backlog dynamics: preserved and
observed, never the primary proof. Once step 4 passes, a fresh DiffCI.com run with separate
`Typecheck` / `Test` steps flows through VERIFIED admission and stage economics on its own - the
end-to-end production check, without a manufactured sweep result.

## Fix 4 (F2) — runner lifecycle: durable, job-pinned dispatch with provenance, 2026-09-05

**Diagnosis, from a live tail of the runner Worker during a controlled push (07:09Z) and the
container application's own state.** Three faults, each now attributable rather than "runner failed":

1. *Dispatch ran inside the webhook's `ctx.waitUntil()`.* Every dispatch event in the tail ended
   `"outcome": "canceled"` at 29.6 s; "minted registration token, starting sandbox runner" was the last
   line the Worker ever logged for a job. The container kept running (jobs did complete), but the
   Worker never learned a runner's fate, and a dispatch that failed to start left no trace at all.
2. *Every runner registered with the same two labels.* GitHub assigns a runner the OLDEST queued job
   its labels qualify for. The runner spawned for job 101267766892 (`cf-job-101267766892`) executed job
   101260055348, queued an hour earlier; the runner spawned for the observation job executed a CI job
   from the previous push. New work was starved by its own backlog - exactly the "pushes create runners
   that service old work" dynamic - and a job whose first dispatch was lost waited 24 h and was
   cancelled, because GitHub never re-delivers `workflow_job.queued`.
3. *Capacity.* The container application (`diffci-github-runner-githubrunner`) showed 5 live instances
   against `max_instances: 5` with `sleepAfter: 12m`: an instance idling for 12 minutes after its job
   held a slot the next job could not get. The burst of ten pushes between 02:12Z and 03:38Z on
   2026-09-03 is the plausible onset; the tail could not prove a capacity failure directly (no dispatch
   failed during the capture window), so it is recorded as the mechanism that fits, not as observed.

**Fix (commit `293b69c`, runner Worker deployed 07:22Z; migration
`schema-migration-2026-09-05-runner-job-lifecycle.sql`; queue `diffci-runner-dispatch`):**

- *Job-unique label.* Both workflows run on `[self-hosted, cloudflare, "diffci-job-${{ github.run_id }}"]`
  and the runner registers with the job's own labels, so no other runner can take a pinned job and a
  pinned runner cannot be assigned another pinned job. (`${{ github.job }}` renders empty in the
  `runs-on` context; the run id alone is unique for these single-job workflows.)
- *Durable dispatch.* The webhook only records the stage and enqueues; the Queue consumer owns the
  whole runner lifecycle inside its 15-minute limit, records every stage in `runner_job_lifecycle`
  plus an append-only `runner_job_events` trail (queued → dispatch requested → dispatch started →
  token minted → container started → job assigned, with the runner GitHub actually assigned →
  execution completed, with conclusion → runner disposition), classifies a start failure as
  capacity / timeout / other and retries with delay; `MAX_DISPATCH_ATTEMPTS` stops a deterministic
  failure visibly. `in_progress` and `completed` deliveries are the assignment and execution
  provenance - a runner serving a job other than the one it was spawned for is now recorded, not
  inferred.
- *Reconciler* (cron every 5 minutes, also `GET /lifecycle?reconcile=1`): queued jobs never
  dispatched, failed, or stale are re-enqueued within the application's remaining capacity.
- *`sleepAfter` 3 m* (was 12 m), so an idle instance stops holding one of the five slots.
- `GET /lifecycle` (bearer) is the qualification tool: recent jobs, or one job's full stage trail.

**Qualification, commit 1 (`293b69c`, pushed 07:23:48Z - the commit that carries the pinned
workflows):**

| stage | CI job 101269602409 (pinned) |
|---|---|
| workflow queued | 07:23:49 |
| dispatch requested (webhook) → container started | 07:23:49 → 07:23:53 |
| runner registered / job assigned | 07:24:29, to **its own** runner `cf-job-101269602409` |
| execution completed | 07:27:15, `success` |
| runner disposition | `exec-succeeded` |

No subsequent push or other repository event was needed; the reconciler's first tick (07:25) came
after the assignment. **Observed and recorded honestly:** the same commit's *observation* job's pinned
runner (`cf-job-101269602490`) was assigned legacy job 101260055854 instead - a pinned runner's labels
are a superset of a legacy plain-label job's, so while plain-label jobs remain queued GitHub may hand
them a pinned runner (never the reverse). The observation job stays queued until the reconciler
re-dispatches it; the hazard disappears once the legacy backlog is drained, which the reconciler is
doing (two legacy CI runs in progress at 07:29Z). The eight pre-fix queued runs are being processed
as incident evidence, not cleaned up.

**Qualification reset.** Commit 2 (`c9d026d`, 07:37:16Z) reproduced the same hazard on its CI job:
its pinned runner `cf-job-101271285538` was assigned legacy job 101266031670 at 07:37:59 (recorded,
not inferred), and the CI job stayed queued; the same commit's observation job ran on its own runner
and completed (its `failure` conclusion is the self-observation action's own pre-existing failure,
unrelated to the runner). A stall resets the sequence, so commits 1 and 2 do not count. Root cause of
the residual hazard: a pinned runner still carried `cloudflare`, so its labels were a superset of a
legacy job's. Fixed in `f9d20c3` (runner Worker deployed 07:40Z): pinned jobs require only the pin
label (`runs-on: [self-hosted, "diffci-job-<run id>"]`) and pinned runners register with the pin label
alone - no cross-eligibility with the legacy backlog in either direction. The reconciler also
re-dispatches a job whose runner exited without ever being assigned it (`runner_gone`), immediately
rather than after the stale window.

One more correction before the clean sequence (`70e3dda`, deployed 07:48Z): the first pin-only
registration stripped `cloudflare` even for jobs whose workflow (at their commit) still required it,
so two re-dispatched runners registered with fewer labels than their jobs required and sat idle while
the jobs stayed queued. Registration now mirrors the job's own required labels exactly; pin-only
follows from the pin-only workflow, not from stripping. The reconciler recovered both jobs on their
third attempt (07:49–07:52Z); the backlog was then empty: **zero queued runs at 07:56Z**, every
pre-fix run resolved by the reconciler, none cancelled by hand.

**Qualification, clean sequence - commit 3 (`70e3dda`, pushed 07:56:33Z, queue empty before it):**

| stage | CI job 101273625704 | observation job 101273625154 |
|---|---|---|
| labels (as delivered) | `self-hosted, diffci-job-33953910146` | `self-hosted, diffci-job-33953910050` |
| workflow queued → dispatch requested (webhook) | 07:56:36 | 07:56:36 |
| container started (registered `diffci-job-…` only) | 07:57:17 | 07:56:38 |
| job assigned, to its **own** runner | 07:57:58 `cf-job-101273625704` | 07:57:08 `cf-job-101273625154` |
| execution completed | 08:00:31 `success` | 07:57:15 (`failure` - the self-observation action's own pre-existing failure) |
| runner disposition | `exec-succeeded` | `exec-succeeded` |

No subsequent push, no reconciler action, no other repository event. Commit 4 is the docs commit
that records this table; its own trail is recorded in the entry below it.

**Qualification, clean sequence - commit 4 (`f63d139`, pushed 08:02:39Z, queue empty before it):**

| stage | CI job 101274360897 | observation job 101274361028 |
|---|---|---|
| workflow queued → dispatch requested (webhook) | 08:02:41 | 08:02:41 |
| container started | 08:02:43 | 08:05:37 |
| job assigned, to its **own** runner | 08:03:15 `cf-job-101274360897` | 08:06:19 `cf-job-101274361028` |
| execution completed | 08:05:37 `success` | 08:06:28 (`failure`, self-observation action, pre-existing) |
| runner disposition | `exec-succeeded` | `exec-succeeded` |

**Two consecutive fresh commits (3 and 4) progressed queued → runner assigned → executing → terminal
on their own runners with no subsequent push and no other repository event. Step 4's success
condition is met.** Queue depth after both: 0. Every stage is attributable from the trail.

**The step-3 payoff, end to end, without a manufactured result.** Commit 3 (`70e3dda`) was a
SELECTIVE prediction (2 of 208 tests selected) whose CI run - executed by its pinned runner with the
split `Typecheck` / `Test` steps - was admitted as VERIFIED ground truth (identity mode, run
33953910146) and, on the next stage-economics tick, produced the first separable test-stage row for
this repository: `test / explicit_step / ESTIMATED`, measured test-step duration with an estimated
avoidable figure of ~122 s for that commit. Six such separable rows now exist (the split-step commits
that ran); the 72 earlier rows remain `explicit_step_inseparable / UNKNOWN`, as they should. This is
an ESTIMATED figure on a single commit - potential, not validated, not billable (the savings evidence
levels stand) - but it is the first test-stage estimate in this repository's history that rests on
admitted evidence, an identified run, an executed job, and a separably measured step.

**Observations recorded, not fixed (none affects the success condition):**
- The Queue consumer dispatched the two jobs of one push serially in commit 4 (the observation
  container started only when the CI exec resolved, ~3 minutes later), so a push's second job waits
  behind its first. Cloudflare Queues scale consumer concurrency up gradually; a per-job Durable
  Object alarm or a higher steady concurrency would remove the wait. Assignment still followed within
  40 s of each container start.
- The self-observation workflow's job fails on every run (`failure` conclusion, the `./` action
  itself) - pre-existing, unrelated to the runner, visible now because the runner executes it.
- Two idle pin-only runners from the 07:43Z mis-registration remain as `offline` ephemeral
  registrations on GitHub until GitHub prunes them; harmless.
- A cron tick and a manual reconcile within the same minute enqueued a job twice; the consumer's
  in-flight guard skipped the duplicate (recorded as such). A dedupe on enqueue would be tidier.
- Dispatch-to-assignment latency for a pinned job is 30–45 s (runner download, dependency install,
  registration), the disclosed cost of the pre-published-image design.

## Fix 5 — the customer-facing read boundaries, 2026-09-05

**Found after the freeze, by asking how an external user would see any of this.** The public
per-repository report (`GET /v1/shadow/report`, no auth, the URL the welcome page hands every
installer) and the product dashboard (`/app`) both still read pre-repair data. Fetched live for
DiffCI.com: 9431 s across 94 runs, all "other", 18 evaluable failures - the retired legacy economics
table (self-observation runs merged in, substring classification) and ground truth with no validity
filter. The report's footer described the evidence discipline correctly; its numbers predated it.
The offline script had been switched in step 3; the live route and the dashboard boundary had not.

**Fix (commits `e29d1fc`, `140e4db`; research and product Workers deployed):**
- The live report reads `shadow_stage_economics` (VERIFIED) with the same aliasing as the offline
  script, counts safety over VERIFIED ground truth only, and says so on the safety line.
- **Explicit missing-evidence-workflow state.** A repository with no identified evidence workflow now
  renders, before any number: *"STATUS: SHADOW - AWAITING CI EVIDENCE WORKFLOW IDENTIFICATION …
  Predictions may be generated (N in this window), but ground truth and savings evidence are not yet
  available. Zero observations here means nothing has been admitted as evidence - not zero
  opportunity."* An identified repository names its evidence workflow at the top. This is a distinct
  state from "insufficient data", by design. Self-service workflow selection was deliberately NOT
  built (founder: product work before the problem is understood); founder configuration stands for
  the first installs, and the report tells the user that is how identification happens.
- The dashboard's safety snapshot counts VERIFIED rows only and carries `evidenceBasis` +
  `verifiedGroundTruthRows`; the safety block carries an `evidenceWorkflow` state
  (`identified` / `awaiting_identification` with the notice above / `no_repositories`); the overview's
  savings figures carry `savingsBasis: "count_based_projection"` and a `savingsNotice` a consumer must
  show - they are projected from selected-test counts, not derived from admitted CI evidence.

**Live after the fix (07:5xZ–08:3xZ):** DiffCI.com - "Evidence workflow: .github/workflows/ci.yml",
112 observed runs, 19 785 s measured, test stage 17 407 s with 672.5 s estimated avoidable across the
9 separable split-step observations, 17/17 evaluable failures preserved over VERIFIED rows only.
unjs/nitro (unconfigured) - the AWAITING state with "34 in this window". DentalPresence.in -
COLLECTING, 2 observed runs, test stage measured 293 s with unknown opportunity (inseparable), 1/1
preserved over VERIFIED rows.

**Operational finding, recorded.** The first deploy of the repaired route answered every request with
a Worker exception: three SQL string literals (`'['`, `']'`, `'VERIFIED'`) lost their quotes in transit
through a shell-quoted patch, and the fake-D1 unit test could not notice. A real-SQLite regression
test (`tests/research/cloudflare/shadow-report-query-sqlite.test.ts`) now runs the route's actual
queries against the actual migration files and caught the second casualty before the second deploy.
Public routes that assemble SQL get a real-database test, not a fake, from here on.

## Fix 6 — seamless installation, 2026-09-05

**Founder requirement, superseding the earlier "founder configuration for the first installs":** an
install must need no intervention. The evidence standard does not move; the proof moves from a
person to a mechanism that shows its work. Commits `25dbbe6`, `f3b959d`, `58b7282`; migrations
`schema-migration-2026-09-05-shadow-auto-identification.sql` and `…-contact-inbox.sql`; research,
product and site Workers deployed.

**Automatic, mechanical evidence-workflow identification** (`src/shadow/workflow-identification.ts`,
pure; `shadow-identification-job.ts` gathers the facts). Every workflow file under `.github/workflows`
is parsed; only push/pull_request-triggered ones qualify; every `run:` command is resolved through
package.json scripts (npm/pnpm/yarn/bun, pre/post hooks, depth-limited, cycle-safe); GitHub's step
groups (`parallel:`) are flattened and `${{ matrix.* }}` references expanded to every candidate value;
steps are classified by what they execute (test runners, `turbo run test`-style task runners for a task
literally named `test`, tsc/vue-tsc/svelte-check, linters, bundlers, e2e runners; mixed or
install-bundled steps are inseparable); the stage layout is derived with GitHub's real job and step
names (`Run <first line>` for unnamed steps); the workflow that runs the tests on the default branch
is chosen, runners-up recorded. The derivation - every candidate, why chosen or excluded, the resolved
commands - is persisted verbatim. NONE_FOUND names every workflow and its reason. The derivation
reproduces both hand-written configurations (DiffCI.com pre- and post-split, DentalPresence.in) in
tests. It runs from the enrollment webhook (Queue message), on any push that touches
`.github/workflows`, and from the cron for any repository still without an evidence workflow.
A founder-set configuration (`evidence_workflow_source = 'explicit'`) is never overwritten.

**Verification before economics.** The stage sweep checks an automatically derived layout against the
executed run's real job/step names before writing any economics row: only executed jobs count (a
skipped job says nothing either way - found on nuxt/nuxt, where a docs-only commit skipped every test
job); a derivation is `verified` only when a derived test step actually ran; a contradiction withdraws
the identification, records why, and the cron re-derives.

**Explicit states, never zeros.** The report renders, before any number: NOT ENROLLED; CANNOT OBSERVE
(archived / no tsconfig anywhere, with the reason); OBSERVATION PAUSED (with the reason); NO CI TEST
WORKFLOW FOUND (with every workflow's reason); AWAITING IDENTIFICATION (not yet attempted, or shape
mismatch with the detail). An automatically identified repository shows the reasoning and whether an
executed run has verified it.

**Corpus run, the mechanical verification the founder asked for.** Running identification across the
research corpus found two classifier gaps and one verification gap before any external install could:
nitro's `parallel:` step groups, astro's task-runner and matrix-provided test scripts, and nuxt's
skipped test jobs; plus two over-eager heuristics (a bare "typecheck" word, a task named `test:size`).
All fixed and pinned in tests. Result: unstorage, h3, defu, nitro, astro and nuxt all identified
automatically (`ci.yml` in each case - by mechanism, not by name); nuxt already has 5 VERIFIED
ground-truth rows and stage rows under its derived layout. DiffCI.com and DentalPresence.in keep their
explicit configurations, which the derivation reproduces.

**Private repositories.** Enrollment records the installation payload's `private` flag and generates a
report token; a private repository's report answers 404 without the exact token (indistinguishable
from "not enrolled"; verified live on DiffCI.com and DentalPresence.in: 404 / 404 wrong token / 200
right token). The token is shown only on the signed-in dashboard (report links per repository), now
at `app.diffci.com`. Public repositories stay public by URL.

**Budget fairness.** `reserveLaunchSlot` refuses past a per-repository cap (20/day) and a research-corpus
cap (24/day) ahead of the 60/day ceiling, each refusal labelled.

**Site.** A script now runs in front of the assets (`run_worker_first`): http → https and
www → apex redirect (both verified 301); www attached as a route because the hostname's pre-existing
DNS record blocks a custom domain; `/contact` posts to a D1 inbox (`POST /v1/contact`, founder reads
`GET /v1/contact/inbox`) - no mailbox required; the welcome page states that identification is
automatic and how a private repository's report is reached.

**Founder one-time action done (2026-09-05):** the Shadow App's Setup URL is `https://diffci.com/welcome`
with redirect-on-update, so GitHub lands installers on the welcome page; verified live with GitHub's
query parameters. Nothing per install remains. The stranger install journey is now complete end to end.

### Fix 6 addendum — private-repository reports reachable, 2026-09-05 (`ebb4d96`, `ab959df`)

**Gap found after the founder set the Setup URL:** the dashboard's sign-in was unconfigured, so a private
repository's report token - shown only there - could reach nobody. Public-repository installs were
complete; private ones enrolled and observed correctly but their owners could not read the report, and
the welcome page promised otherwise. Recorded as an overstatement in the earlier closing report.

**Fix.** The founder registered a GitHub OAuth App (login only, `read:user user:email`; runbook in
`docs/product/2026-09-05-github-oauth-app-registration.md`) and set its credentials plus `CSRF_SECRET`
on the product Worker. Authorisation is GitHub's own answer, not ours: the research Worker's new
`GET /v1/shadow/report-access?login=` (dispatch token) asks, with the Shadow App's installation token,
whether that login is a collaborator on each App-installed repository (`shadow-report-access.ts`);
204 is access, 404 is not, anything else is *unknown* and rendered as "could not check", never as
access and never as "no repositories". Only App-installed repositories are candidates - the polled
corpus has no installer. The product dashboard calls it over a Service Binding (`RESEARCH_WORKER`) and
lists the user's accessible repositories with tokenised links for private ones; every failure is
"unavailable, because …" rather than an empty list. The private token appears nowhere else.

**Verified live:** sign-in button rendered; `/auth/github` redirects to GitHub with the
`app.diffci.com` callback and identity-only scopes; report-access for the founder login returns both
private repositories with tokens and for `octocat` returns none, `unknown: []`. **Outstanding:** the
product Worker's `RESEARCH_DISPATCH_TOKEN` secret is founder-set (the automated attempt was blocked by
the assistant's own permission gate); until it is set the dashboard says the report service is not
connected. Deploy note: re-running `shadow:deploy` on an already-uploaded commit is refused by the
source-integrity gate (archive hash differs run to run); the Worker itself had deployed - the gate
protects the source record, not the deploy.

**Closed 2026-09-05.** The first credential entry had stored a lone Ctrl-V byte as the client id (Git
Bash does not paste on Ctrl-V), which sent sign-in to a GitHub 404; `05f5dbe` validates both OAuth values
before use so a malformed pair reads as "not configured" with the reason logged. The founder re-entered
both values and `RESEARCH_DISPATCH_TOKEN`, signed in at app.diffci.com, and saw both private
repositories (DiffCI.com, DentalPresence.in) under "Your shadow reports" with working tokenised links.
Private-repository reports are reachable end to end; no per-install founder action remains.
