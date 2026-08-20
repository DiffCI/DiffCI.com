# Stage 0 full experiment — Gate 2 report (~1,000 cumulative deltas)

**Result: GATE 2 PASSED.** Global unique deltas: **1,003** (`COUNT(DISTINCT logical_delta_key) =
COUNT(*) = 1003` - zero duplicates, verified via direct D1 query, not the Worker's own claim).

## What was dispatched since Gate 1

3. `unjs/ofetch`, `unjs/h3`, `sindresorhus/ky` (concurrency=3) - all COMPLETE, first attempt, zero errors.
4. `pmndrs/zustand` (concurrency=1) - **failed on first attempt** (see below), succeeded on retry.

All 10 of the medium batch's originally-kept repositories are now fully re-analyzed at their full
100-commit target under `stage0-full-2026-08-21`: `axios/axios`, `colinhacks/zod`, `pmndrs/jotai`,
`pmndrs/zustand`, `sindresorhus/execa`, `sindresorhus/ky`, `trpc/trpc`, `unjs/defu`, `unjs/h3`,
`unjs/ofetch`.

## Real transient-failure finding (not a STOP condition - the orchestrator working as designed)

`pmndrs/zustand`'s first dispatch attempt failed with a genuine Cloudflare Sandbox error:
`"Sandbox operation files.writeFileStream was interrupted while the runtime connection was closing"`
- a live, real container connection-lifecycle failure of the same class documented during the medium
batch (the `max_instances` contention issue). This is exactly the category of failure the orchestrator's
retry/resumability design exists to handle.

**What actually happened, verified independently via D1 (not assumed from the Worker's response):**

- No corrupted or partial evidence was persisted by the failed attempt: `pmndrs/zustand`'s unique-delta
  count stayed exactly 35 (its pre-existing banked total) both before and immediately after the failure
  - `COUNT(DISTINCT logical_delta_key) = COUNT(*) = 35`, unchanged.
- The repository was left in a cleanly resumable state (`RUNNING`, `orchestrator_attempts: 1`), not
  silently dropped or marked falsely COMPLETE.
- Re-dispatching (`orchestrator_attempts` became 2) succeeded cleanly: `resumedDeltas: 35` (correctly
  did NOT re-analyze the 35 already-banked deltas), `newDeltasAnalyzed: 65` (exactly the remaining
  work), `duplicateDeltasPrevented: 0`, `errors: []`, all 100 records returned.
- Final D1 state: `pmndrs/zustand` at exactly 100/100 unique deltas, zero duplicate rows, a single
  `repository_runs` row (correctly UPSERTed, not duplicated) showing `status: COMPLETE,
  orchestrator_attempts: 2`.
- Global uniqueness held throughout: 1,003 unique deltas = 1,003 total rows, before, during, and after
  this failure/retry cycle.

This is a genuine, live (not synthetic) demonstration of the same property Gate 0's crash-resume test
validated artificially - real Cloudflare transient failures do not corrupt evidence, do not duplicate
work, and do not require manual intervention to recover from. Per the frozen methodology, this is not a
STOP condition (it is a transient container failure, correctly retried) and required no code change.

## Budget

Real measured spend after Gate 2: **$0.1449** total (`budget_ledger`, wall-clock-based). Still
approximately three orders of magnitude under the $2,000 ceiling and consistent with the pre-Gate-1
projection.

## Decision

Proceeding to Gate 3 (~1,500 cumulative deltas): next dispatching `unjs/unstorage` (needs ~97 more of
its 100-commit target - the last repository with partial existing progress) followed by however many of
the 9 never-before-touched repositories (`honojs/hono`, `nestjs/nest`, `typeorm/typeorm`,
`TanStack/query`, `date-fns/date-fns`, `mikro-orm/mikro-orm`, `unjs/unstorage`, `unocss/unocss`,
`pmndrs/valtio`, `redis/ioredis`) are needed to cross ~1,500. These carry zero resumability credit (full
fresh clone + 100-commit analysis each), so expect a materially higher wall-clock cost per repository
than the partially-banked repositories dispatched so far.
