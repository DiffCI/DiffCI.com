# MECHANISM_PROOF_01 — mutation result

Run `tsjest-mutate-01`, job `tsjest-mechanism-mutation`. Protocol frozen at `73681f1`, amended at
`84dd44e`, both before any mutation result existed. Evidence and sha256 in
`docs/evidence/mechanism-proof-mutation/`.

Environment identical to the observation: `docker.io/cloudflare/sandbox:0.12.5`, node `v22.23.2`,
Ubuntu 22.04.5, agent `sha512-mlNTeKlr…`. 55.6 minutes in `mutating`.

## Primary safety metric

```
FALSE GREENS = 0 / 3 recall-measurable selective decisions = 0.0%
```

No selection let a defect through that the full suite caught.

## The matrix

The comparator column is ABSENT, not empty — see amendment M3. This apparatus never runs the comparator
against a mutation.

| # | head | classification | DiffCI sel | comparator sel | detecting | efficiency |
|---|---|---|---|---|---|---|
| 1 | `06c79d4ce` | **RECALL_UNMEASURABLE** | 7/40 | 40 | — | — |
| 2 | `394181875` | RECALL_CONFIRMED | 7/38 | 2 | 3 of 7 | SELECTION_OVERBROAD |
| 3 | `a82a2b32c` | RECALL_CONFIRMED | 7/38 | 2 | 1 of 7 | SELECTION_OVERBROAD |
| 4 | `8a8fd2fb8` | **FULL_NO_SELECTION_RISK** | — | — | — | not mutated (M1) |
| 5 | `96d025dd9` | RECALL_CONFIRMED | 2/38 | 38 | 2 of 2 | EFFICIENT |

Re-observation matched the frozen classifications on all five, to the selected count, total and
comparator count. No divergence defect.

## The stated success criterion is HALF met

The criterion was: zero false greens **while candidate 1's 7/40 and candidate 5's 2/38 actually catch
their defects.**

- Candidate 5's 2/38 caught its defect. Both selected tests detected it.
- **Candidate 1's 7/40 was never tested.** Reverting *both* of its revertible source files — including
  `src/legacy/compiler/ts-compiler.ts`, the file the fix commit changed — produced **no full-suite
  failure at all.**

Candidate 1 was the most informative of the five: no test file changed, so all 7 selections were
graph-derived. Its recall is unmeasured, and this run does not establish it. It stays in the
denominator as `RECALL_UNMEASURABLE`.

It also refutes a premise stated in the protocol above — that a `fix:` commit's defect is one "the
repository's own authors considered worth a test." For candidate 1 that is false: the suite cannot see
that fix being undone.

## Economics — CPU-seconds, on the unmutated tree

`Incremental = C_comparator − (C_diffci_selected + C_joint_analysis)`, joint analysis charged entirely
to DiffCI.

| # | full | comparator | DiffCI | joint | **incremental** | gross vs FULL |
|---|---|---|---|---|---|---|
| 1 | 320.69 | 301.39 (40) | 302.80 (7) | 2.32 | **−3.73** | +15.57 |
| 2 | 294.39 | 246.82 (2) | 288.86 (7) | 1.98 | **−44.02** | +3.55 |
| 3 | 284.74 | 222.09 (2) | 275.09 (7) | 2.26 | **−55.26** | +7.39 |
| 5 | 269.66 | 262.29 (38) | 46.72 (2) | 2.37 | **+213.20** | +220.57 |
| | | | | **total** | **+110.19** | +247.08 |

**Three of four candidates are NEGATIVE against the comparator.** The aggregate is positive only
because of candidate 5, which alone contributes +213.20 of the +110.19 net.

This is the pattern the standing instruction warns about — a strong aggregate obscuring the individual
results — so the aggregate is not the headline. **DiffCI lost to the comparator on 3 of 4 commits.**

## What the cost structure actually shows

Selection SIZE does not predict cost:

```
candidate 2, comparator:  2 files -> 246.82 CPU-s
candidate 5, DiffCI:      2 files ->  46.72 CPU-s
```

Same count, 5.3x the cost. `src/legacy/compiler/ts-compiler.spec.ts` is most of this suite's cost on its
own, so selecting it costs nearly a full run regardless of what else is or is not selected. Candidate
5's saving comes from being the one case that avoids that file.

Consequence for the product claim: **savings here are governed by whether the change touches the
expensive test, not by how many tests are pruned.** A per-test or per-file savings model would be wrong
on this repository. This is one repository and is not generalised.

## Open, and not resolved by this run

- **M2 stands unresolved.** Qualification recorded 20 test files; the survey and observation recorded
  40 (38 at the older commits). The collected log carries only the harness's own summary, not jest's
  `Test Suites:` lines, so what jest actually executed is still not established. If the runner's
  universe is narrower than DiffCI's, the `7/40` and `2/38` fractions overstate their denominators. The
  CPU measurements above are unaffected — they are measured, not derived from counts.
- **M3, the comparator recall column.** Candidates 2 and 3 selected 7 against the comparator's 2, and
  only 3 and 1 of those 7 detected the mutation. Whether the comparator's 2 were among the detecting
  tests is NOT established, so "overbroad" here means larger, not proven unnecessary.

## What this establishes

`∃ workload where DiffCI safely saves compute` — **supported, narrowly.** Candidate 5: 2 tests of 38,
defect caught, 213.20 CPU-s saved against the comparator on a real external repository under a protocol
sealed before any result was seen.

**It does not establish** that DiffCI usually saves compute. On this evidence it usually did not: 3 of 4
commits cost more than the path-rule comparator. Zero false greens across 3 measurable mutations is a
denominator of 3.

---

# FROZEN — 2026-08-31

M2 is closed (`docs/mechanism-proof-01-m2-closure.md`) and this result is frozen as it stands.

## The result, stated in full

```
3 measurable selective decisions
  -> 3 recall confirmed
  -> 0 observed false greens
  -> 1 economically positive, 2 economically negative
1 selective decision recall-UNMEASURABLE
1 conservative FULL
```

This is the reportable form. **Not** "4/5 selective", and **not** "+247 CPU-s savings" — both of those
are true sentences that leave a reader with a false impression.

## Denominator correction from M2

jest executes **20** test files, not the 40/38 DiffCI reported (defect 17: discovery never intersects
its universe with the runner's `testMatch`). Every selection fraction in the tables above overstates its
denominator by roughly 2x. Corrected:

| candidate | as reported | true |
|---|---|---|
| 1 | 7/40 | **7/20 = 35%** |
| 2, 3 | 7/38 | **7/20 = 35%** |
| 4 | 9/38 | **9/20 = 45%** |
| 5 | 2/38 | **2/20 = 10%** |

**No measured quantity changes.** The CPU figures are executed measurements, not count-derived. And no
selected test on any candidate fell outside jest's `testMatch`, so the recall verdicts stand.

## The supported claim

> **There exists an externally selected historical workload where DiffCI retained defect detection while
> materially reducing measured compute relative to the repository-derived comparator.**

Candidate 5: 2 of the 20 executed test files, defect caught by both, +213.20 CPU-s incremental against
the comparator.

## What is NOT claimed

- **Not** that DiffCI usually beats a cheap path/co-location heuristic. This sample points the other
  way: 3 of 4 commits cost more than the comparator.
- **Not** general safety. Zero false greens over a denominator of 3.
- **Not** that the graph's contribution is established. Candidate 1 was the clean test of that — 7
  purely graph-derived selections, no changed test file — and it is recall-unmeasurable.

## Recorded alongside

- `docs/product-finding-cost-awareness.md` — test count is not compute; the selector should become
  cost-aware as well as dependency-aware. Recorded, deliberately not acted on.
- `docs/laboratory-defects.md` defect 17 — discovery ignores the runner's configuration.

## Next

Not a new repository draw yet, and explicitly not collecting repositories until the percentages look
good. The open question is whether candidate 5's shape — dependency-aware selection safely avoiding an
expensive test that a path heuristic cannot exclude — repeats on independently selected repositories.
**A finding that it does not repeat is a result, not a failed run.**
