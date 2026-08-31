# MECHANISM_PROOF_01 — mutation protocol

**Frozen before any mutation result exists.** The observation it follows is frozen at `ddc6151`.

## The observation corpus, with its provenance

| | |
|---|---|
| run | `tsjest-observe-01` |
| repository | `kulshekhar/ts-jest` |
| pinned tree | `b1a97ac485711377e01e72bac8b115e41a1c17ba` |
| container image | `docker.io/cloudflare/sandbox:0.12.5` |
| node / npm / git | `v22.23.2` / `10.9.8` / `2.34.1` |
| OS | Ubuntu 22.04.5 LTS, Linux 6.18.36 firecracker |
| agent digest | `sha512-mlNTeKlrkt6TqWBGi9e5O/QM90t7vXpmwyBIly5Mm1glHzRotWmV1s9A1PK3zJIwfntHEgh8S/t3lRJOYucN8g==` |
| DiffCI commit | `4151db2` (source tarball `bc70376801f5d200`) |
| candidate draw | sealed at `07bc3d1`, five pairs, verified 5/5 verbatim |
| raw evidence | `docs/evidence/mechanism-proof/` with sha256 checksums |

## What the mutation is

Each of the five candidates is a `fix:` commit. The mutation is **reverting that fix's implementation
file** in the head tree — the mechanism `dogfood-mutate` already uses, unchanged. This reintroduces the
**historical defect the commit was written to fix**, which is why these candidates are worth mutating
rather than injecting synthetic faults: the failure is one the repository's own authors considered
worth a test.

## The matrix

For every candidate, in this order:

```
1. baseline        full suite on the unmutated head        must be GREEN, else the candidate is dirty
2. mutate          revert the implementation file
3. full arm        full suite on the mutated tree          expected FAIL - if it PASSES the mutation is
                                                           unmeasurable and is reported as such
4. comparator arm  path-rule selection on the mutated tree FAIL / PASS
5. DiffCI arm      DiffCI selection on the mutated tree    FAIL / PASS
```

```
historical defect  →  caught by full?  →  caught by comparator?  →  caught by DiffCI?
```

with DiffCI's selection size and each arm's CPU alongside.

## The outcome that matters most

```
full = FAIL   and   DiffCI = PASS      →   FALSE GREEN
```

A false green means DiffCI proposed a subset that would have let a real regression through. **One is
disqualifying for this proof** and is reported at the top of the result, not in caveats. It is not
offset by savings on other candidates.

## Fixed in advance

- **All five run.** Including candidates 2 and 3, where the comparator selected 2 and DiffCI selected 7
  — those are the cases that can show whether DiffCI's extra six impact tests were **necessary**,
  partly justified, or plain over-selection. Dropping them because they look unflattering is the one
  thing that would make this exercise worthless.
- **Candidate 4 is FULL** and is run anyway. It should behave exactly like the full suite; if it does
  not, something is wrong with the accounting rather than with DiffCI.
- **`RECALL_UNMEASURABLE` stays in the denominator.** A reverted file whose absence the suite does not
  notice proves nothing either way, and hiding those inflates the apparent recall.
- **No candidate is re-drawn, substituted or skipped** for any result.
- **No analyser change** between the observation and the mutation. `4151db2` is the commit under test.

## Accounting, unchanged from every prior economics run

```
CPU is primary; wall time reported separately.
Incremental = C_comparator − (C_diffci_selected + C_joint_analysis)
joint analysis charged ENTIRELY to DiffCI.
Gross versus FULL reported alongside, never instead.
Install and build are common unavoidable work and are reported SEPARATELY — they are not savings
attributable to test selection.
```

Negative savings are preserved as measured. If DiffCI costs more on a candidate, the negative number is
reported.

## Re-observation is part of the pipeline, not a re-litigation

`dogfood-mutate` consumes a corpus **and the per-commit agent reports**, which carry the selected-test
identities. Those reports live in the run's scratch directory and were not collected from
`tsjest-observe-01`, so the mutation run re-observes the same five sealed pairs to regenerate them.

**The classifications from that re-observation are compared against the frozen ones at `ddc6151` and
must match.** Observation is static analysis over pinned commits, so any divergence is a defect and is
reported as one rather than absorbed.

## What a clean result would and would not establish

**Would:** that on a real external repository, under a protocol sealed before any DiffCI result was
seen, DiffCI's graph-derived selections retained the tests that detect the historical defects — while
costing materially less than the full suite.

**Would not:** general safety. Five mutations on one repository is an existence result, and the recall
rate it implies has a denominator of five.

**Would not:** scale, or commercial economics. ts-jest has 40 test files.

---

## Amendment M1 — candidate 4, recorded before the mutation run

Written after reading `dogfood-mutate` and **before any mutation result exists.**

The protocol above says all five candidates run. Reading the harness shows candidate 4 cannot:
`dogfood-mutate` skips any corpus row whose `decision.mode` is not `SELECTIVE`, and candidate 4
(`8a8fd2fb8`) is `FULL`. It will produce no mutation attempt.

**The filter is not being loosened.** Loosening a safety filter to manufacture a data point is the
wrong direction, and this one is correct on the merits: a FULL decision means DiffCI runs the entire
suite, so its arm is the full arm by construction. A false green is impossible, and the saving is zero
or negative. Mutating it would confirm an identity, not measure recall.

So candidate 4 is reported as **`FULL_NO_SELECTION_RISK`**, in the matrix, in the denominator, with this
reasoning attached — not dropped and not quietly counted as a pass.

**The recall denominator is therefore 4 measurable candidates, not 5.** Any recall figure this run
produces is out of 4 at best, and out of fewer if a mutation turns out unmeasurable.

## Amendment M2 — a discrepancy to resolve with measurement, not assumption

Qualification recorded ts-jest as **20 test files, 358 tests**. The density survey and the observation
recorded a test universe of **40**. Both numbers are from this project's own logs and they do not agree.

The likely explanation is that DiffCI's discovery counts `.spec.ts` files that this jest configuration
does not actually execute — but that is a hypothesis, and this project has a documented history of
confident inferences that were later refuted. It is **not** assumed here.

The mutation run measures it directly: the full arm reports how many suites jest ran. If DiffCI is
selecting from a universe wider than the runner's, the selection fractions (`7/40`, `2/38`) overstate
the denominator, and **the reported savings would be overstated with it**. That is checked and reported
whatever it shows.
