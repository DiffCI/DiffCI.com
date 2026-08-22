# Stage 2F — prospective observation daily log

Durable, append-only daily snapshots for the Stage 2 14-day prospective-observation window. One entry per
calendar day (UTC), captured either manually (interactive session) or by the `DiffCI Stage 2F Daily
Observation Snapshot` cloud routine (`trig_01AZTyUSfZcHtMMxvaKMAFoC`, daily 03:15 UTC).

**observation_start_at** = `2026-08-21T03:10:40.609Z` (first `trigger_source='cron'` row in
`shadow_cron_runs` — the unattended `*/10 * * * *` Cloudflare Cron Trigger's own execution log; the
immediately-preceding manual bootstrap run at `03:00:15.209Z` is the one-time human activation step, not
autonomous operation).

**gate_e_eligible_at** = `2026-09-04T03:10:40.609Z` (`observation_start_at` + 14 days, exact, not a
calendar approximation).

**Algorithm freeze:** no semantic changes to impact/graph/traversal/planning/fallback/evaluator/risk-policy
logic are made during this window. Stage 2D/2E's D1-D5 controlled bugs were each reverted to byte-identical
original state and CI-confirmed green after each revert, so the algorithm at `observation_start_at` and at
every snapshot below is the same code.

**Known, pre-existing exceptions (not new anomalies unless their state changes):**
- Two DentalPresence.in stuck predictions, `no_matching_workflow`, ages growing steadily (both created
  2026-08-21 ~06:1x UTC) — `logicalDeltaKey` prefixes
  `adityankale190895/DentalPresence.in:74c8104e...:62b47d53...` and
  `adityankale190895/DentalPresence.in:...6f0d4a65...:37ca6d23...`.
- DentalPresence.in's `deploy`/`check` job compound-test-tagging limitation (Stage 2D Part 9 audit): a
  structural risk that has not manifested in any of its 18+ historical reconciled observations. Tracked as
  an open measurement issue, not fixed.
- D4 (Stage 2D commit `b7cd05b`) permanently excluded from the Gate C "legitimate evaluable failures" count
  — typecheck-only failure, `test` never ran.

**Note on data source per entry:** entries marked `[D1]` include the full breakdown (SELECTIVE/FULL
evaluable-failure split, discriminative-opportunity count, zero-selection tracking) from a direct D1 query.
Entries marked `[HTTP]` come only from the Worker's public `/v1/shadow/reconcile-diagnostics` and `/health`
endpoints (used when D1/MCP access isn't available in that moment) and do **not** independently confirm
Gate C/D numbers that day — those require a `[D1]` check before being relied on for the final Part 13-15
review.

---

## 2026-08-22 (Day 1) — `[D1+HTTP]`

- Snapshot time: `2026-08-22T04:41:34Z` (observation age: ~1d 01h31m)
- **D1 aggregate** (queried 04:38 UTC, just before the MCP connector session dropped):
  - `total = 65`, `discriminative = 28`, `selective_mode = 43`, `full_mode = 21`
  - By `plan_mode`: SELECTIVE → `evaluable = 5`, `preserved = 5` (42/43 reconciled); FULL → `evaluable = 1`,
    `preserved = 1` (20/21 reconciled) — the FULL row is D4, correctly isolated and excluded from Gate C.
  - **False negatives: 0** (`preserved == evaluable` in both mode groups).
  - `shadow_cron_runs`: 152 cron-triggered runs from `observation_start_at` through `2026-08-22T04:20:11Z`,
    ~10 min cadence, **zero gaps, zero errors** in the entire sequence — full uptime so far.
- **HTTP reconcile-diagnostics** (04:41:34 UTC): `total = 65`, `reconciled = 63`, `pending = 2`,
  `pendingReasons = [{"no_matching_workflow": 2}]` — both are the known DentalPresence rows
  (ages ~80.9M ms / ~22.5h and ~80.6M ms / ~22.4h), no new stuck rows.
- Worker `/health`: `{"ok":true}`.
- Deltas since observation start: n/a (first entry).
- Anomalies: **none**. No false negatives, no prediction-after-ground-truth violations, no new stuck rows,
  no new `pendingReasons` types, health OK.
- This entry was written manually (interactive session); the daily cloud routine's first scheduled run is
  `2026-08-23T03:15:00Z`.
