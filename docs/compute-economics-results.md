# Compute economics: measured CPU, not test counts

All runs in the canonical Linux environment (`docker.io/cloudflare/sandbox:0.12.5`, node v22.23.2),
under **agent generation B**, unsharded, with all three execution arms run back to back in one container
on the **unmutated tree** — the state a customer's CI is in day to day.

Unsharded deliberately: running containers concurrently would add CPU contention to the very quantity
being measured, and would add it unevenly across arms over time.

## The two questions

```
grossCpu       = C_full       - (C_diffciSelected + C_jointAnalysis)   "cheaper than running everything"
incrementalCpu = C_comparator - (C_diffciSelected + C_jointAnalysis)   "worth paying for"
```

Gross is the easy question. FULL is a soft benchmark: beating it proves only that selecting fewer tests
costs less than selecting all of them. **Incremental is the business case** — it asks whether DiffCI's
intelligence beats a cheap path rule *after DiffCI pays for producing its own selection*.

The comparator pays **zero** analysis CPU, even though its selection is computed from `profile`, which
the dependency-graph build produces. That allocation is deliberately generous to the comparator (see
`docs/../scripts/dogfood-mutate.ts`), so a positive incremental result cannot be an artefact of how
shared analysis cost was divided.

---

## honojs/hono — `hono-economics-02`, 2026-08-30

Frozen `2026-08-30T05-17-21-952Z-honojs-hono-1567c9`, 6/6 checksums verified.
22/22 compute-measurable. Safety funnel identical to the agent A run: 20/20 confirmed, 0 false greens,
4 efficient / 4 comparable / 12 overbroad.

```
full                    1928.94 CPU-s
comparator selected      439.12
diffci selected          447.71
joint analysis            72.31   (charged entirely to DiffCI)
diffci total             520.02

grossCpu       = 1928.94 - (447.71 + 72.31) = +1408.92
incrementalCpu =  439.12 - (447.71 + 72.31) =   -80.90
```

**Per-candidate incremental sign: 4 positive, 18 negative.**

### This is the result that makes the meter credible

Test counts predicted hono should mostly lose: 12 of 20 measurable mutations were
`SELECTION_OVERBROAD`. CPU measurement, an independent instrument, says the same thing. It did **not**
report DiffCI winning everywhere — which is the outcome that would have indicted the meter before the
result could be interesting.

### The structure is coherent, not noisy

```
commit       fullCpu  compCpu  diffciCpu  analysis     incr   sel(comp/diffci)
c409d855d      86.86    80.20      37.14      3.25   +39.81   123/83
796776074      87.10    81.79      36.37      3.49   +41.93   123/83
9c28d724c      87.88     9.34      39.65      3.28   -33.59    19/91
531e9c5a3      84.98     7.99      37.55      3.27   -32.83    18/83
499c35ebd      87.84     3.66      10.82      3.31   -10.47     3/18
28a9c1289      89.93     1.90       1.90      3.06    -3.06     1/1
```

**All four positives are cases where the path rule blew up to 123 tests and DiffCI selected 83.**
Wherever the path rule was tight (1–19 tests), DiffCI lost. On `28a9c1289` both sides selected exactly
one test, both cost 1.90 CPU-s, and DiffCI still lost by 3.06 — entirely to analysis overhead.

So the honest characterisation is **not** "DiffCI is worse than a path rule". It is:

> DiffCI pays a fixed ~3.3 CPU-s toll to insure against the path rule occasionally selecting 123 tests.
> On hono, that insurance costs more than it saves.

### Two structural facts that bound any selector here

- **Analysis overhead ~3.3 CPU-s** — roughly the cost of running 1–3 hono tests. At small selection
  sizes it dominates the comparison.
- **A ~1.9 CPU-s floor per invocation**, even for a single test, from vitest startup and hono's
  config-enabled coverage. No selector can go below it.

### What is not claimed

No verdict label is attached. There is no established noise threshold for this measurement — though
−80.90 against a 439 comparator total is well outside anything plausibly attributable to noise, and the
4/18 sign split is not a marginal call.

Wall time is recorded beside CPU in the frozen bundle and is never substituted for it: hono's full arm
takes ~32s wall but ~88 CPU-s, because vitest saturates workers. A wall-clock analysis would have
understated the cost of the full suite by roughly 3×.

---

## colinhacks/zod — pending

Test counts predict the opposite sign: 629 DiffCI-selected against 761 comparator-selected across the
five safety-measurable cases. If CPU measurement reproduces that qualitative difference — hono negative,
zod positive — the two results together are considerably stronger than either alone, because the same
instrument will have distinguished two repositories in the direction an independent signal predicted.
