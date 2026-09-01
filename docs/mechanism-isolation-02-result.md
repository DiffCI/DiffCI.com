# MECHANISM_ISOLATION_02 — result, and the close of the mechanism line

Run `mi2-mutate-01`. Protocol and pool frozen at `c08de74`; target drawn from that commit's hash.

```
target   c48c48c9d  fix(prefer-expect-assertions): use correct word in error message
base     e0cdeb59b
changed  src/rules/prefer-expect-assertions.ts     (1 file, ZERO test files)
```

## Outcome: `RECALL_UNMEASURABLE`

```
reverting src/rules/prefer-expect-assertions.ts did NOT fail the full suite
```

The comparator and direct-only arms did not run — with no full-suite failure there is nothing to detect.

**This is the outcome the frozen protocol said would close the line**, and it closes it. There is no
MI-03.

## The observation: a second independent `GRAPH_REACHED`

| | |
|---|---|
| decision | `SELECTIVE`, `SAFE_TO_PROPOSE` |
| selected / universe | **2 / 159** (comparator 149) |
| `DIRECT_CHANGED` | 1 — `src/rules/prefer-expect-assertions.ts` |
| **`GRAPH_REACHED`** | **1 — `src/rules/__tests__/prefer-expect-assertions.test.ts`** |

The commit did not touch that test. DiffCI reached it through the graph — the **second** such
observation, on an independently drawn candidate under a different eligibility rule.

## Economics

```
full         64.30 CPU-s   (159 files)
comparator   59.88 CPU-s   (149 files)
DiffCI        4.27 CPU-s   (2 files)
joint         2.05 CPU-s   (charged to DiffCI)

incremental vs comparator = 59.88 − 6.32 = +53.56 CPU-s
gross versus FULL         = 64.30 − 6.32 = +57.98 CPU-s
```

**Replication evidence only** — recall was unmeasurable, so there is no detection outcome to pair the
saving with. Third consistent cost measurement (+71.48, +43.81, +53.56) on one repository.

## Why the fix criterion did not deliver a measurable mutation

Worth recording as a methodological finding rather than an excuse.

All four entries in the sealed pool were **message or description fixes** — "use correct word in error
message", "make message less ambiguous", "a far better message", "update description". On this
repository, ESLint rule tests assert on **`messageId`**, not on literal message text, so changing the
text is invisible to them. That is *why* those commits changed no test file: nothing needed updating.

**The mechanically-defined `fix:` criterion is not a reliable proxy for "behaviour visible to tests" on
this repository.** It selected exactly the class of fix the suite cannot see. The rule was defensible
prospectively and I would freeze it again; it simply did not hold here.

There is a real interaction the criterion could not know: *changed no test file* and *behaviour-visible*
are close to mutually exclusive on a repository whose tests are message/fixture-driven. A behaviour
change usually forces a fixture update, which disqualifies the candidate under the isolation shape.

## The evidence ladder, closed

| | detection | graph contribution | economics |
|---|---|---|---|
| **GENERATION_C_01** | ✅ `RECALL_CONFIRMED`, no false green | **0 graph-reached** — diff sufficed | +71.48 CPU-s incremental |
| **MI-01** | ⬜ unmeasurable | ✅ 1 graph-reached | +43.81 (replication) |
| **MI-02** | ⬜ unmeasurable | ✅ 1 graph-reached | +53.56 (replication) |

**Established:** DiffCI makes safe selective decisions on a blind-drawn external repository; it reaches
tests the diff cannot identify (n = 2, independent draws); it costs ~4–6 CPU-s where the comparator costs
~52–77 and the full suite ~59–85.

**Not established:** that graph reach changes a **detection** outcome. Two prospective attempts, both
unmeasurable. The bridge is still missing, and I am not claiming it.

**Zero false greens** across every measurable candidate in the project to date.

## What happens now

Per the frozen boundary: **the bespoke mechanism programme ends here.** No MI-03, no Generation D or E
safety campaign. The apparatus becomes continuous evaluation infrastructure, and engineering effort goes
to the product trajectory —

```
repository CI inference → whole-pipeline execution model → incremental CPU/cost optimisation
                        → proprietary learning/retraining loop
```

The detection question is not abandoned; it is **re-homed**. Continuous evaluation across many
repositories will encounter behaviour-visible mutations without anyone designing an experiment to find
one, and the `direct-only` arm now exists to answer it whenever that happens.

## The claim, unchanged

> Same detected outcome at dramatically lower compute on the blinded case. The causal contribution of
> graph intelligence is **partially evidenced** — reach demonstrated twice, detection not yet
> demonstrated.

No "13.4× smarter CI". No mechanism claim without the direct-only arm missing.
