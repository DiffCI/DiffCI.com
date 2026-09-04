# 2026-09-04 — Push-triggered shadow polls were dying at the 30-second `waitUntil` limit

**Status:** fixed and deployed 2026-09-04. Observation gap on `adityankale190895/DentalPresence.in`
ran from 2026-08-27T01:58Z to the first post-fix poll; nothing in that window is recoverable as
prospective evidence (see "What was lost").

## Symptom

DentalPresence.in, enrolled `github-app-webhook`, was last polled on 2026-08-27T01:58:57Z at
`a852252` (the squash root commit) and recorded zero predictions afterwards. 168 commits were pushed
to `main` after that (GitHub `/commits?since=` count, 2026-09-04), every one with completed
workflow runs, and every `workflow_run` delivery for the repository reached the Worker with a 200
`reconcile-scheduled`. DiffCI.com looked healthy by comparison (polled 2026-09-03T13:21Z), which is
why the first guess was "push deliveries for one repository are not arriving".

`docs/yc/metrics.md` (entry "Own-repo installs confirmed live, 2026-09-04") had read DentalPresence's
20 predictions as proof the webhook path worked "through today". All 20 date from 2026-08-21. That
entry is corrected in place.

## Evidence

All from D1 (`diffci-research`) and GitHub, not from Worker logs — the Worker logs held nothing
durable, which is the second half of the bug.

| Fact | Source |
|---|---|
| DentalPresence.in `last_polled_sha = a852252`, `last_polled_at = 2026-08-27T01:58:57Z` | `shadow_repositories` |
| DentalPresence.in predictions: 20, all `prediction_created_at` on 2026-08-21 | `shadow_predictions` |
| DentalPresence.in `last_poll_attempt_at = 2026-08-21T14:08Z` (liveness columns are cron-only; the webhook path never wrote them) | `shadow_repositories` |
| 168 commits on `main` after a852252; latest push 2026-09-04T09:34Z; workflow runs completed | GitHub REST |
| `workflow_run` deliveries for DentalPresence.in: OK 200, `reconcile-scheduled` | App delivery log via `/v1/shadow/app-info?delivery=` |
| DiffCI.com: commit `db903b0` at 13:20:57Z, predictions for `4cca922`/`db903b0` at 13:21:21–24Z, `last_polled_at` 13:21:27Z — the whole poll took **30 s** | `shadow_predictions`, `shadow_repositories` |
| DiffCI.com: prediction for `f85cf10` at 16:02:31Z exists, but `last_polled_sha` is still `db903b0` and `70d8e48` (pushed with it) has no prediction — the poll died between the first prediction insert and the cursor update | same |
| DiffCI.com's two subsequent pushes (`f85cf10`, `70d8e48`) never advanced the cursor | same |

The pattern — a poll completes only when it finishes within about 30 s of the webhook response, and a
slower one stops mid-way with no error anywhere — is exactly the documented `ctx.waitUntil()` limit:
"For HTTP-triggered Workers, `ctx.waitUntil()` can extend execution for up to 30 seconds after the
response is sent" (Cloudflare Workers runtime docs, `context`). Cancelled promises log a warning to
Workers Logs and nothing else.

## Root cause

`validation-worker.ts`'s webhook handler ran the entire container poll (extract source, `npm ci`,
clone, analyse, write predictions, advance cursor) inside `ctx.waitUntil()`. That only ever fits in
30 s for a small repository on a warm container. DentalPresence.in is a larger monorepo; its one
successful webhook poll on 2026-08-27 was the *rebaseline* after the squash (no analysis, fast). Every
later push started a poll that was killed before it wrote anything, and because the cursor never moved,
each attempt re-derived the same growing backlog — a deterministic failure repeated 168 times with no
durable trace.

The analysis-fanout Worker hit the identical class of bug on 2026-08-23
(`docs/research/blind-baseline-2026-08-23/…-fanout-fixes.md`, item 1, "FATAL — move orchestration out
of `ctx.waitUntil`") and moved to a Durable Object alarm. The shadow poll had the same `waitUntil` at
its core and was not re-examined then.

Secondary cause: the webhook path had none of the cron path's accounting. No launch-slot reservation,
no liveness update, no consecutive-failure auto-pause, no run record. `listPollableRepositories()`
excluded webhook-enrolled repositories entirely, so the 10-minute cron sweep — which head-checks and
polls with a long enough budget — never looked at them either. There was no safety net.

## Fix (commit on `main`, 2026-09-04)

1. **Queue consumer.** The webhook now enqueues one message per push (`SHADOW_POLL_QUEUE`, queue
   `diffci-shadow-poll`, `max_batch_size` 1, `max_retries` 0) and the same Worker's `queue()` handler
   runs the poll with a 15-minute invocation budget. The decision layer is
   `src/research/cloudflare/shadow-push-poll.ts`, dependency-injected and unit-tested like
   `shadow-cron.ts`. The ci-reproduction bridge (EXTERNAL_ENGINE_BRIDGE_01) rides the same queue for
   the same reason; its 30-minute container timeout still exceeds the consumer budget, so a very long
   bridge run can be cut off — recorded as an in-flight row, not silent.
2. **Durable trail.** New table `shadow_push_polls` (migration
   `schema-migration-2026-09-04-shadow-push-polls.sql`): a start row is written before any container
   work and closed with the outcome (`succeeded` / `failed` / `refused-state` / `refused-source` /
   `refused-ceiling` / `refused-unknown-repository`). `GET /v1/shadow/cron-status` returns the recent
   rows as `recentPushPolls` and reports `pushPollQueueBound`.
3. **Same accounting as the cron.** A push poll reserves a daily launch slot, updates the liveness
   columns, and auto-pauses after `maxConsecutivePollErrors` failures.
4. **Cron safety net.** `listPollableRepositories()` now includes `github-app-webhook` repositories.
   The sweep's cheap head check catches a lost delivery, a refused enqueue, or a consumer that died,
   within 10 minutes. A repository with a push poll in flight (start row younger than 15 minutes, not
   finished) is head-checked and its transition recorded, but not launched — the two paths never share
   a sandbox session.
5. **Diagnostics.** `/v1/shadow/app-info` accepts `limit` (≤100) and `cursor` so one repository's
   push deliveries can be found among another's `workflow_run` bursts.

## What was lost

The 168 DentalPresence.in commits between a852252 and the first post-fix poll. The poll's shallow clone
depth is 100, so `a852252` is no longer reachable and the first post-fix poll re-baselines at the
current head without predicting (the documented fail-safe in `cloudflare-shadow-poll.ts`). Even if it
were reachable, predictions made now for commits whose CI finished days ago would not be prospective.
No backfill is attempted; the gap is stated, not papered over.

DiffCI.com lost `70d8e48` (and whatever the queue picks up first will re-derive from `db903b0`, which
the `logicalDeltaKey` dedup handles).

## Verification

- Unit: `tests/research/cloudflare/shadow-push-poll.test.ts` (12 cases), cron in-flight cases in
  `shadow-cron.test.ts`, store cases in `shadow-store.test.ts`.
- Live, deploy 2026-09-04T11:03Z (Worker version `f7952e1c`, source `95edf28`, integrity CURRENT,
  `pushPollQueueBound: true`):
  - **DiffCI.com, queue path.** The fix commit's own push at 11:04:12Z was enqueued at 11:04:1xZ
    (Worker log: `enqueued poll … at 95edf28`), the consumer opened its `shadow_push_polls` row at
    11:04:17Z and closed it `succeeded` at 11:05:53Z — **96 s**, three times the `waitUntil` limit
    that killed the previous poll. 3 new commits seen (`f85cf10`, `70d8e48`, `95edf28`), 2 predictions
    recorded (`f85cf10`'s already existed — the `logicalDeltaKey` dedup), launch slot 8 consumed,
    `last_polled_sha` advanced to `95edf28`.
  - **DentalPresence.in, cron safety net.** 11:10Z tick: head check saw `a852252 → db01257`,
    transition recorded, launch attempted, failed `npm-ci-failed: Command timed out after 120000ms`
    (recorded in `shadow_cron_runs.errors`, `consecutive_poll_errors` 1). 11:20Z tick: succeeded,
    re-baselined at `db01257` with 0 predictions exactly as predicted above, counter reset to 0,
    `last_poll_success_at` written for the first time since 2026-08-21. First poll of this repository
    in 8 days.
  - **Bridge.** The same push's ci-reproduction-bridge message ran 11:05:53–11:07:59Z and failed on
    the same 120 s `npm ci` timeout inside its own container. Under `waitUntil` this failure was
    invisible; it is now a `shadow_push_polls` row with the error text. The `npm ci` timeout
    (`prepareContainer`, 120 s) was a pre-existing constraint that bit on a cold container — it
    also failed withastro/astro's slot 4 earlier the same day. Raised to 300 s the same day, on the
    founder's instruction, once the trail made it measurable rather than silent.
