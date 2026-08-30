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

## colinhacks/zod — `zod-economics-01`, 2026-08-30

Frozen `2026-08-30T06-01-05-518Z-colinhacks-zod-3dfe87`, 6/6 checksums verified.
11/11 compute-measurable. Safety funnel identical to the agent A run: 5/5 confirmed, 0 false greens,
4 efficient / 0 comparable / 1 overbroad.

```
full                    2280.10 CPU-s
comparator selected     1794.18
diffci selected         1561.15
joint analysis            49.83   (charged entirely to DiffCI)
diffci total            1610.98

grossCpu       = 2280.10 - (1561.15 + 49.83) = +669.12
incrementalCpu = 1794.18 - (1561.15 + 49.83) = +183.20
```

**Per-candidate incremental sign: 9 positive, 2 negative.**

### The contrast the test counts predicted

| | hono | zod |
|---|---|---|
| gross | **+1408.92** (73% of full) | +669.12 (29% of full) |
| incremental | **−80.90** | **+183.20** |
| sign split | 4 positive / 18 negative | 9 positive / 2 negative |

The same instrument, on two repositories, produced opposite signs in the direction an independent
signal predicted. That is worth more than either result alone: a meter reporting DiffCI winning
everywhere would have been indicted by hono, and one reporting it losing everywhere would have been
indicted by zod.

Not uniform either — 9 of 11 rather than 11 of 11. Uniformity would have suggested something
structural rather than earned.

### Gross and incremental rank the two repositories oppositely

hono has by far the larger **gross** saving (73% of full) and a **negative** incremental. zod has a
modest gross (29%) and a **positive** incremental. Anyone quoting gross would call hono the better
case; the number that decides whether DiffCI is worth paying for calls it the worse one.

### One rule explains both repositories

DiffCI's selection is comparatively **stable** — ~83 tests on hono, ~125–127 on zod regardless of
commit — while the path-rule comparator is **volatile**: 1–123 on hono, 113–193 on zod.

```
commit       fullCpu  compCpu  diffciCpu  analysis     incr   sel(comp/diffci)
0a69bcb3d     189.02   205.59     124.94      4.37   +76.28   189/126
9a193aa24     246.54   177.65     133.76      4.10   +39.79   189/126
773a48676     213.33   130.84     120.84      4.48    +5.52   132/126
2e1f2b414     211.61   117.00     122.88      4.47   −10.35   113/125
fb3af01f7     220.35   140.97     160.48      5.28   −24.79   134/127
```

DiffCI wins exactly when the comparator over-selects, and loses when the comparator is tight. That is
the same rule that held on hono. The repositories differ only in how often the cheap rule blows up: on
zod the comparator selected 189+ tests on 7 of 11 candidates; on hono it selected fewer than 20 on 18
of 22.

**So the product is not "smarter selection" in general. It is a stabiliser that caps the blast radius
of a cheap rule, and its economics depend on how often that rule over-selects on a given repository.**
That is falsifiable, and it predicts where DiffCI should and should not be sold.

### Why analysis overhead mattered on hono and not here

zod's analysis toll (~4.5 CPU-s) is a rounding error against selections costing 120–160 CPU-s. hono's
(~3.3 CPU-s) was decisive because its selections often cost 2–11 CPU-s. **Analysis overhead is only
significant where the selection is small — which is precisely where a path rule is already good
enough.**

### What is not claimed

n=11, of which only 5 are also safety-measurable. No verdict label is attached and no reliability
estimate is offered. +183.20 against a 1794 comparator total is roughly 10%, well outside plausible
noise — but one repository at n=11 is an indication, not a savings claim.

---

## vuejs/core — `vue-economics-01`, 2026-08-30 — the out-of-sample test

Frozen `2026-08-30T08-01-32-113Z-vuejs-core-9f5cf3`, 6/6 checksums verified. 16/16 compute-measurable.
Safety: 14/14 confirmed, 0 false greens. Efficiency: 1 efficient / 0 comparable / **13 overbroad**.

**The prediction was committed at `243d110` before this job existed.**

```
full                    2050.82 CPU-s
comparator selected      430.78
diffci selected         1536.07
joint analysis            58.04   (charged entirely to DiffCI)
diffci total            1594.11

grossCpu       = 2050.82 - (1536.07 + 58.04) =  +456.71
incrementalCpu =  430.78 - (1536.07 + 58.04) = -1163.33
```

| | |
|---|---|
| **Predicted sign** | **NEGATIVE** |
| **Measured sign** | **NEGATIVE** |
| Predicted magnitude (modelled) | −1092.54 |
| Measured magnitude | −1163.33 |
| Per-candidate | **0 positive, 16 negative** |

The **sign** is what was pre-registered and the sign was correct. The magnitude landed within 6.5%,
which is interesting but secondary — file costs are heterogeneous and the magnitude model was never the
claim.

### Three candidates where DiffCI cost more than running everything

```
ef82a2677   gross = −3.18   DiffCI selected 183/196
a2b40db9a   gross = −3.15   DiffCI selected 183/196
4e467d7ae   gross = −5.09   DiffCI selected 183/196
```

Not merely worse than the cheap comparator — worse than **doing nothing at all**. DiffCI selected 183 of
196 files and then charged ~3.6 CPU-s of analysis on top. This is only visible because the analysis toll
is charged rather than assumed away, and because gross is reported rather than treated as self-evidently
positive.

### The three-repository picture

| Repository | Incremental CPU | Candidate signs | Comparator behaviour |
|---|---:|---:|---|
| honojs/hono | −80.90 | 4+ / 18− | usually tight |
| colinhacks/zod | **+183.20** | 9+ / 2− | often broad |
| vuejs/core | −1163.33 | 0+ / 16− | tight; DiffCI very broad |

---

# Three conclusions, kept separate

**Safety.** 39/39 canonical recall-measurable cases confirmed across hono, zod and vue, with 0 observed
false greens. This is a milestone, **not a reliability rate**: 39 cases cannot support one.

**Economics.** DiffCI's incremental economics are **repository-dependent** — positive on zod, negative
on hono and vue. Benchmarking against FULL alone would have inverted the ranking on all three.

**Prediction.** A pre-registered selection-based rule correctly predicted vue's incremental sign out of
sample. Evidence across three repositories is consistent with comparator over-selection being predictive
of whether DiffCI's additional analysis pays for itself.

**The hypothesis is NOT proven.** Three repositories make this interesting and investable as a thesis;
they do not establish generality. One correct out-of-sample prediction is one correct prediction.

# The open technical question, now the highest-value one

Vue exposed a product problem rather than a benchmark loss. Across sixteen commits DiffCI's selections
took four dominant sizes — **57, 97, 162, 183** — in a 196-file universe, 13 of 16 candidates classified
`SELECTION_OVERBROAD`, none was economically positive, and three cost more than the whole suite.

The question to answer next is **not** "how do we make Vue positive". It is:

> **What causes each selection bucket, and does every selected file have an auditable dependency or
> impact reason for being included?**

Two outcomes, both valuable:

- **The 183 files are genuinely required by the dependency model.** Then Vue is simply a repository
  where DiffCI is not economically useful — which is acceptable, and the predictor could let the product
  decline deployment there rather than make a customer's CI more expensive.
- **The 183 arises from conservative graph collapse, fallback behaviour, package-level widening,
  unresolved imports or a configuration boundary.** Then this is the next real product bottleneck.

Not started. Repository #4, carbon conversion and selector optimisation are all deliberately deferred
until this is understood.
