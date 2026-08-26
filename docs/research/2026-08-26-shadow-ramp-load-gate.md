# Shadow ramp — 24-hour load gate (predeclared)

**Declared 2026-08-26, BEFORE enrolling `vitest-dev/vitest` and `unjs/nitro`.** Recorded in advance so the
outcome cannot be graded against thresholds invented after seeing the results. If a threshold below turns
out to be wrong, the honest move is to say so and change it deliberately — never to quietly reinterpret it.

## Why a gate at all

Until now the three enrolled repositories (`unjs/h3`, `unjs/unstorage`, `unjs/defu`) were dormant —
collectively **zero** default-branch commits in five days. The pipeline has therefore never run under real
load. `vitest` and `nitro` commit roughly 27–31 times a week each, so this is the first time the shadow
system does meaningful work, and roughly a hundredfold increase in analysis volume.

`maxPollsPerRun` bounds a single sweep, **not** a day's spend. At 144 sweeps/day and `maxPollsPerRun: 3`
the previously-unbounded worst case was **432 container launches per day** — a number nobody chose, and
which only stayed harmless because the repositories were quiet. A hard daily ceiling was added before
enrollment (`maxPollsPerDay`), not after.

## Ceilings (hard, enforced in code)

| Limit | Value | Enforcement |
|---|---|---|
| Analysis launches per UTC day | **60** | `DEFAULT_SHADOW_CRON_CONFIG.maxPollsPerDay`, checked before any head check spends an API call |
| Analysis launches per sweep | **3** | `maxPollsPerRun` (unchanged) |
| Container instance type | `standard-2` | `wrangler.research-sandbox.jsonc` |
| Worst-case container minutes/day | **~360** | 60 launches × 6 min hard per-exec timeout |
| Expected container minutes/day | **~40–80** | ~10–20 real head changes/day × ~4 min typical |

60/day was chosen for ~5–10 real head changes per repository per day, which leaves generous headroom
while capping the worst case at roughly one seventh of the previous unbounded figure.

## Pass criteria — all must hold after 24 hours

1. Analysis launches ≤ 60/day, and the ceiling is **never** silently hit (refusals are recorded in
   `dailyCeilingRefusals`, not swallowed).
2. Container/compute spend within the expected band above; no unexplained excursion toward the worst case.
3. **Zero uncontrolled retries** — no repository re-analysed repeatedly for the same head.
4. **Zero resource kills** — no container terminated by the platform.
5. **Zero fingerprint write conflicts.**
6. **≥95% eligible-capture coverage** (`capturedPredictions / eligiblePredictions`).
7. `sourceIntegrity` is `CURRENT` on every sweep that consults it. `undefined` is **not** a failure — a
   head-check-only sweep never consults the archive.
8. Cron and per-repository liveness healthy: `LIVE` or `IDLE_UPSTREAM`, never `STALE` or `DEGRADED`.
9. Per-repository analysis latency and classified fraction reported honestly, including when unflattering.
10. **No savings claimed from `UNKNOWN` or non-test stages.** Structurally enforced already
    (`estimateStageEconomics` refuses non-test stages), and re-verified against real rows.

## Metrics captured over the window

- head changes detected
- **intermediate commits missed** because several landed between sweeps (the poller analyses the latest
  head, so this is a real and expected gap that must be measured rather than assumed to be zero)
- predictions created
- FULL vs SELECTIVE split
- classified fraction, per repository
- estimated avoidable work (tests only, `ESTIMATED` tier)
- container runtime and cost

## Expansion rule

- **Gate passes** → add `vitejs/vite`, `withastro/astro`, `nuxt/nuxt`.
- **Low classified coverage on either repository** → do **not** adapt the engine. Preserve the blind
  evidence first and categorise the gap. A low number is the measurement working, not a defect to tune
  away before it has been understood.
- **Gate fails** → fix operational scaling before adding any repository.

## What this cohort is for

Discovering where DiffCI's current model works and where it conservatively refuses — not manufacturing an
attractive savings figure. An uncomfortable classified fraction on a large monorepo is a useful result.

Public-repository enrollment is **validation, not adoption**: these maintainers have not installed
anything and are not customers. Customer recruitment proceeds separately.
