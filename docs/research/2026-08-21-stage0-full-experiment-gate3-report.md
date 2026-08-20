# Stage 0 full experiment — Gate 3 report (~1,500 cumulative deltas)

**Result: GATE 3 PASSED**, reached and exceeded en route to Gate 4 (1,790 unique deltas by the time this
was written, verified `COUNT(DISTINCT logical_delta_key) = COUNT(*) = 1790`, zero duplicates).

## What was dispatched since Gate 2

- `unjs/unstorage` (97 new), `honojs/hono` (100 new), `date-fns/date-fns` (100 new) - concurrency=3,
  all COMPLETE, zero errors.
- `nestjs/nest` (100 new) - COMPLETE, zero errors.
- `typeorm/typeorm` - **first attempt's client-side `curl` call timed out after 25 minutes with zero
  bytes received**, but server-side work continued independently and checkpointed to 90/100 by the time
  it was checked. Re-dispatched (`orchestrator_attempts: 2`) and completed cleanly: `resumedDeltas: 90`
  (correctly did not re-analyze), `newDeltasAnalyzed: 10`, zero duplicates.
- `TanStack/query`, `mikro-orm/mikro-orm` - COMPLETE at concurrency=5, zero errors.
- `unocss/unocss` - **failed** at concurrency=5 with `"Maximum number of running container instances
  exceeded. Try again later, or try configuring a higher value for max_instances"`.
- `pmndrs/valtio` - **failed** at concurrency=5 with `"Sandbox operation sandbox.exec was interrupted
  while the platform was updating the sandbox runtime"` (unrelated platform-maintenance interruption,
  not a concurrency issue).

## Two real findings, both handled correctly (neither a STOP condition)

**1. Client-side HTTP timeout does not lose server-side progress.** `typeorm/typeorm`'s first dispatch
outlived the 1500-second client timeout on the `/v1/orchestrate` call. Verified via direct D1 query
(not assumed): the repository's `commits_analyzed` checkpoint had advanced to 90 with a fresh
`completed_at` timestamp, entirely independent of whether the HTTP client was still listening. This is
exactly the intended behavior of checkpointing per-batch in D1 rather than relying on the HTTP
response - confirms the "orchestrator must not become a single point of failure" design holds even
when the *client* driving dispatch (not the Worker) is what fails.

**2. Concurrency=5 (the exact `max_instances` ceiling) leaves zero real headroom.** Raising dispatch
concurrency from 2-3 to the full documented ceiling of 5 (a deliberate choice, made with the user's
explicit approval after being offered the safer 2-3 default as an alternative) caused a genuine
`"Maximum number of running container instances exceeded"` failure on one of the five simultaneously-
dispatched repositories. This matches the exact class of problem the medium batch's own
`max_instances: 1 -> 5` fix was meant to solve, now observed again at the raised ceiling itself: even
"the documented maximum" doesn't leave slack for in-flight cleanup (e.g. two repositories from the same
round finishing and calling `sandbox.destroy()` at nearly the same moment another is starting).
Independently verified via D1 that the failure caused zero corrupted or partial evidence (`unocss`
stayed at its pre-attempt 0/100, `valtio` stayed at its pre-attempt 90/100, both cleanly resumable, no
duplicate rows). Both repositories were successfully retried at a reduced concurrency of 3.

**Decision going forward:** concurrency=3 for any remaining dispatches, not 5 - real evidence now shows
5 is not a safe operating margin, only a documented ceiling.

## Budget

Real measured spend: **$0.3441** total after this round. Still roughly three orders of magnitude under
the $2,000 ceiling.

## Decision

Proceeding toward Gate 4 (~2,000 cumulative deltas) - `unocss/unocss` and `pmndrs/valtio` retries plus
`redis/ioredis` (the last never-touched corpus repository) dispatched at concurrency=3, which if
successful reaches the full ~2,000-delta target in one more round.
