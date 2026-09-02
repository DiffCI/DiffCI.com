# REGRESSION_02 — full same-five rerun after SEMANTIC_REPAIR_02, frozen

Executed 2026-09-02 against `be11044` (shared command classifier `878c470`, assignment-prefix
normalization `6003751` + correction `a1406f7`, babel-loader naming-policy decision `be11044`). Fresh
source packed (`sources/diffci-976cc98bd507fdfc.tgz`), identical across all five runs (confirmed via each
`execution-receipt.json`). All five dispatched in parallel against the deployed canonical container; raw
artifacts under `docs/evidence/regression-02-full/<repo>/`.

## Result table

| repo | REGRESSION_01 (pre-repair) | REGRESSION_02 (this run) | movement |
|---|---|---|---|
| eslint | `REFUSED` — pinned dependency basis | `REFUSED` — **byte-identical reason string** | control held |
| jest | `REFUSED` — phantom `script-34` | `PARTIAL_REPRODUCTION` — 746 vs reference's 581 tests, 0 failures either side | unchanged since the phase-1 real check (`f818354`); root cause is `nick-fields/retry` action-input modeling, out of scope here (see the correction, `a1406f7`) |
| webpack | `REFUSED` — 2 phantom + 1 genuine blocker | `REFUSED` — **1 genuine blocker only** (`basic-unknown-1`, the real `\|\|` `argvOf` can't turn into safe argv) | phantom blocks fully cleared; not scored, per the frozen plan — `WRONG_JOB_TARGETED` untouched |
| babel | `REFUSED` — phantom `script-32` + genuine `download-artifact` | `REFUSED` — **`download-artifact` only** | exactly the pre-registered negative-regression result, reconfirmed for the second time on a fresh source pack |
| babel-loader | `REFERENCE_NON_DETERMINISTIC` — engine never reached a real attempt | `DIVERGED` — both arms ran the identical 5-step sequence; both hit the same 2 test failures | see below — the label undersells what actually happened |

## eslint — control, held exactly

Reason string is byte-for-byte identical to `REGRESSION_01`'s. No drift across two source repacks and
three rounds of engine changes to unrelated code paths.

## Webpack and babel — reconfirmed, not re-litigated

Both match what phase 1's real run (`f818354`) already established, now reproduced a second time against
a fresh pack that also includes the naming-policy and assignment-prefix changes — those changes touch
neither repository's actual workflow content (per the earlier grep across all four cloned repos), and
this rerun confirms they didn't perturb either result. See `docs/evidence/regression-02/results.md` for
the original analysis; it stands.

## Jest — unchanged, as predicted

Still `PARTIAL_REPRODUCTION`, still `test-leak` instead of `test-runtime-vm-modules`. Nothing in this
phase touched the real cause (`nick-fields/retry`'s `command:` input), so no movement is exactly the
expected, correct result — reported here for completeness of the five-way table, not as new evidence.

## Babel-loader — DIVERGED, but the raw steps say more than the label

Both arms ran the *exact same five commands* (`corepack enable`, `yarn`, `yarn add -D webpack@5`,
`yarn up @babel/*@^7`, `yarn run build`, `yarn test-only`) — the inference plan is now fully executable,
confirmed locally before this run and reconfirmed here. Both `yarn test-only` steps exited `1`. Reading
the raw step data rather than the summary:

```
referenceArm "yarn test-only": exitStatus 1, tests: undefined, failures: 2
inferenceArm "yarn test-only": exitStatus 1, tests: undefined, failures: 2
```

The `outputTail` for both is real TAP output (Node's native `--test` runner emits TAP, not Jest's
format) — individual `ok N - <name>` subtest lines are present, so a suite genuinely ran with real
results in both arms. `classify()`'s `suiteOf()` helper (`scripts/ci-reproduction.ts:453`) requires
`typeof s.tests === "number" && s.tests > 0` to call a step "a suite that ran" — the harness's step-result
parser evidently extracts a `failures` count from TAP output but not a `tests` count, so `suiteOf()`
returns `undefined` for both arms, and `classify()` falls through to `"neither arm executed a suite"` →
`DIVERGED` (`scripts/ci-reproduction.ts:478-480`).

This reads as the same class of thing `classify()` already guards against twice — DEFECT 23 (a harness
execution-bound timeout mislabelled as divergence) and DEFECT 26 (environment signals mislabelled as a
graph defect) — a THIRD case: **the harness's own TAP-output parsing doesn't recognise Node's native test
runner's result format**, not a defect in the inferred graph. The graph is not merely plausible here; both
arms ran identically and failed identically, which is closer to what the outcome vocabulary calls
`UNVERIFIABLE` ("arms agree but no usable CI ground truth exists for the cell") than to `DIVERGED`
("the graph is wrong or incomplete") — except the arms don't just agree with each other, they agree with
the specific, already-known `FLOATING_DEPENDENCIES` mechanism: `yarn add -D webpack@5` is a floating
range, today's registry resolution differs from the commit's original passing run, and the same 2 tests
fail for that reason in both arms alike. This is the third time this exact prediction from `5539155`'s
determinism gate has been confirmed empirically (once in `REGRESSION_01`'s reference-arm-only failure,
once in `REGRESSION_02`'s phase-1 check, now here with both arms failing identically).

**Not fixed here** — a harness-side TAP-parsing gap is a different, separately-scoped repair, not part of
SEMANTIC_REPAIR_02's inference-layer work. Flagged for a future harness pass, not implemented now.

## Freezing this evidence

This closes the `SEMANTIC_REPAIR_02` regression program as scoped: shared command classifier → jest/babel
verification → assignment-prefix normalization (real, correct, zero regression-target effect, per the
correction) → babel-loader naming-policy decision, verified against the real pinned repository. Two things
remain explicitly open, by design, not by oversight:

1. **`ACTION_INPUT_MODELING_01`** (not yet scoped as its own plan) — jest's `nick-fields/retry` case as
   the motivating fixture. Success criterion, stated now so it isn't redefined later: modelling the retry
   action makes the real jest workflow infer the intended `TEST` operation *without* introducing incorrect
   operations elsewhere.
2. **The harness's TAP-output parsing gap**, surfaced by babel-loader in this run — not scoped anywhere
   yet.
