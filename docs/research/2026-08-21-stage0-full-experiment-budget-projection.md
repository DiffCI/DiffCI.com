# Stage 0 full experiment — pre-Gate-1 budget projection (2026-08-21)

Execution-sequence step 8: "Estimate full-run Cloudflare consumption before Gate 1 - using real
telemetry, not blindly trusting the earlier linear projection." This uses two INDEPENDENT real
measurements, not a re-derivation of the earlier estimate.

## Real measured data points

1. **Medium batch (2026-08-21 report):** 500 deltas / 10 repositories, actual Cloudflare spend
   **< $0.10** end to end (real Container billing, not estimated). ≈ **$0.0002/delta**.
2. **Gate 0 crash-resume validation (2026-08-20, this experiment's own orchestrator):** 20 freshly
   analyzed deltas (5 commits × 4 repositories: `pmndrs/jotai`, `pmndrs/zustand`, `unjs/h3`,
   `unjs/ofetch`), real `budget_ledger` rows from `orchestrateOnce`'s wall-clock-based measured-cost
   path: **$0.0073559** total → **≈$0.000368/delta average**, though heavily skewed by one cold-clone
   outlier (`pmndrs/zustand`: 156s wall time vs ~16s for the other three - first-time clone cost, not a
   per-delta cost).

Both independent measurements converge to the same order of magnitude: **≈$0.0002-0.0004/delta.**

## Real resumability data (reduces actual new work below the naive 2,000-delta figure)

Querying `completed_deltas` across ALL prior experiments (medium batch + Gate 0 + the historical-
evidence live-verification call) as of 2026-08-20:

| Repository | Unique deltas already banked |
|---|---|
| `unjs/defu`, `trpc/trpc`, `sindresorhus/execa`, `colinhacks/zod`, `axios/axios` | 65 each (325 total) |
| `unjs/ofetch`, `unjs/h3`, `sindresorhus/ky`, `pmndrs/zustand`, `pmndrs/jotai` | 35 each (175 total) |
| `unjs/unstorage` | 3 |
| **Total already banked** | **503** |

Per `logicalDeltaKey`'s cross-experimentId resumability design, any of these that the full experiment's
deterministic 100-commit sample also selects will legitimately RESUME (D1/R2 read only, no container
work, near-zero cost) rather than being re-analyzed. Whether the full experiment's larger sample is a
strict superset of these smaller ones is NOT assumed here (the sampler is deterministic but not
guaranteed monotonic across different `targetCommits` values) - this is a lower bound on savings, not a
promise.

## Projection

Worst case (zero resumability benefit, full ~2,000 fresh analyses, using the higher of the two measured
per-delta rates with a further 2x safety margin for clone-time variance):

```
2,000 deltas x $0.0004/delta x 2 (variance buffer) = $1.60
```

This is **≈0.08% of the $2,000 budget ceiling** and comfortably under even the $1,600 WARNING threshold
with over 1000x headroom. Budget consumption is not expected to be a constraining or risk factor for
Gates 1-4 of this experiment.

**What actually matters for Gates 1-4 is not budget but operational reliability**: total wall-clock time
across ~1,500-2,000 fresh container analyses bounded by `max_instances: 5` concurrency, retry rate under
`withContainerRetry`, and whether any NEW reliability issue appears at this larger scale (Gate 0 already
found and fixed one real bug - the `/v1/stop` no-op - validating that this kind of issue is exactly what
the gates are designed to catch). Real telemetry (attempts, retryReasons, wall-clock durations, and
measured-vs-projected budget) will continue to be recorded and reported per gate, not assumed from this
projection.

## STOP condition check

Per the frozen methodology's STOP conditions, "projected budget breach" is a STOP condition. This
projection is not a breach - it is roughly three orders of magnitude under the ceiling. No STOP action
is taken on budget grounds. If actual measured spend during Gates 1-4 diverges dramatically from this
projection (per the original task spec's explicit instruction), that divergence itself will be
investigated and reported, not silently absorbed.
