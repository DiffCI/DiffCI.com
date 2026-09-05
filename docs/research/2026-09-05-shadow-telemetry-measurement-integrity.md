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
