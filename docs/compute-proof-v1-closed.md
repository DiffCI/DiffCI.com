# COMPUTE_PROOF_V1 — closed, qualifying pool exhausted

**No compute proof was obtained.** Both qualifying repositories failed the `twoGreenBaselines` gate, for
different reasons, and the pre-registration forbids finding a third by lowering a criterion.

## The two candidates

| | typescript-eslint | jestjs/jest |
|---|---|---|
| mapping density | 99.7% | 38.3% |
| test files | 308 | 1195 |
| test→production edges | 470 | 730 |
| **verdict** | **NOT QUALIFIED** | **NOT QUALIFIED** |
| cause | its own `postinstall` failed — Nx could not load 3 default plugins | suite is **reproducibly red at HEAD** |
| tests executed | none | **all of them, twice** |

## `jest-qualify-02` — the run that actually exercised the gate

```
jestjs/jest    [stage] clone       0.5s
               [stage] install    52.9s
               [stage] build     178.7s
               [stage] baseline 1 507.6s
               [stage] baseline 2 351.9s
not qualified  (1092s)
  999 test(s) failing at HEAD on every run (999, 999)

  run 1: exit=1  parsedFailures=999  cpu=1679.81s  wall=507603ms
  run 2: exit=1  parsedFailures=999  cpu=1096.09s  wall=351911ms

  Test Suites:   29 failed, 4 skipped, 520 passed, 549 of 553 total
  Tests:        999 failed, 275 skipped, 5235 passed, 6509 total
  Snapshots:   1155 failed, 701 passed, 1856 total
```

**J1 worked.** Install, build and both baselines all executed; the correction supplied exactly what was
missing and nothing more. This is a genuine qualification failure, not a registration defect.

### The 999 was verified, not assumed

`999` is a suspiciously round number, and Jest is a repository whose own tests assert on Jest's output —
so the captured diagnostics are full of snapshot diffs that *look* like summaries:

```
| + Tests:       1 failed, 1 total             <- snapshot diff content, not the run's summary
| + Test Suites: 1 failed, 2 passed, 3 total
```

The parser did not take those. The real bottom line is `Tests: 999 failed, 275 skipped, 5235 passed,
6509 total`, identical on both runs, with `exit=1` agreeing. `classifyExecution` returned `RED`, not
`CONTRADICTORY_EXECUTION_EVIDENCE`, which is the correct classification.

**Not investigated:** why 999 tests fail. The likely explanation is e2e tests requiring environment the
container does not provide, but a red baseline disqualifies under the sealed rule, and looking further
would be debugging a candidate to keep it selected.

## The size of the prize, measured and now unusable

Jest's full suite costs **~1,680 CPU-seconds** (run 1) against a ~179-second build. That is exactly the
large workload the experiment wanted, which is what makes this expensive rather than merely
disappointing.

## What V1 established, and what it did not

**Did not:** produce any evidence about whether DiffCI saves compute. The central box is unchecked:

```
safe non-empty selection that actually reduces compute
```

**Did:** produce a pre-registration that eliminated two attractive candidates without intervention.
typescript-eslint's 99.7% connectivity did not save it; Jest's 1,195 tests did not save it. Neither was
rescued by adjusting a threshold, and the single correction made (J1) is documented with independent
evidence that it supplied a documented prerequisite rather than an accommodation.

**Also did:** measure the gate itself. Of the frozen 40, exactly **two** repositories reached the
compute-proof eligibility bar and **zero** cleared it. That is a coverage result, not a DiffCI result,
and belongs with the other coverage findings rather than with the economics.

## Closing terms, as pre-registered

- **No third repository** from this frame.
- **No lowering** of ≥100 test files, ≥30% mapping density, or ≥100 production edges.
- **No further accommodation** of either candidate.

Noted for any V2, which is designed explicitly or not at all: a red canonical baseline has now
disqualified **three** of the repositories that reached it — fastify, axios, jest — which suggests
`twoGreenBaselines`, not connectivity, may be the binding constraint on finding a proof target at all.
That is a hypothesis produced by this closure, not a criterion to relax inside it.
