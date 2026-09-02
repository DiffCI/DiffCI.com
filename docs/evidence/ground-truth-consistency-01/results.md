# GROUND_TRUTH_CONSISTENCY_01 — real-harness verification, prediction confirmed exactly

Implements `docs/ground-truth-consistency-01-plan.md`. Source packed fresh
(`sources/diffci-38c878307f143d57.tgz`, identical across all five runs). Sequence followed as directed:
prediction-matrix unit tests (5 new, already committed at `a1b8b49`) → full suite (1906/1906) →
five-repo regression, real harness. Raw artifacts under `docs/evidence/ground-truth-consistency-01/<repo>/`.

## The critical empirical expectation — met exactly

```
babel-loader
outcome: GROUND_TRUTH_CONTRADICTED
reason: both arms agree (66 tests, 2 failures) but CI ground truth
        Test - ubuntu-latest - Node 22, Babel 7, Webpack 5 recorded "success",
        which implies zero failures. The commit is pinned, so the source
        cannot explain this - check whether the environment (dependency
        resolution, toolchain) differs from what CI originally ran.
```

Both arms still report the identical `66 tests / 2 failures` this exact cell has shown in every run since
`TAP_PARSING_01` first made the count visible — nothing about the *execution* changed. What changed is
that `classify()` now correctly declines to call this `REPRODUCED`.

## The other four — unchanged, confirmed byte-for-byte where a prior baseline exists

| repo | result |
|---|---|
| eslint | `REFUSED`, reason byte-for-byte identical to `REGRESSION_02`'s frozen baseline |
| webpack | `REFUSED`, byte-for-byte identical |
| babel | `REFUSED`, byte-for-byte identical |
| jest | `PARTIAL_REPRODUCTION`, `reference 581/0 vs inference 746/0` — identical to every prior run |

None of these four ever reach the arm-agreement branch this phase changed (eslint/webpack/babel refuse
before execution; jest's arms disagree with each other, landing in the untouched `PARTIAL_REPRODUCTION`
branch) — their being unchanged is exactly what the frozen plan predicted, not a coincidence.

## Reading this result

This closes the semantic hole named at the start of this phase: DiffCI no longer turns repeatability of
the wrong result into evidence of historical reproduction. Babel-loader's two arms have agreed with each
other since the very first `REGRESSION_01` run — what has changed across three phases is what the harness
was capable of seeing and saying about that agreement:

```
REGRESSION_01        REFERENCE_NON_DETERMINISTIC   (engine never reached a real attempt)
ACTION_INPUT_MODELING_01 / TAP_PARSING_01 (pre-fix)  DIVERGED   ("neither arm executed a suite" - untrue, both did; the harness just couldn't count it)
TAP_PARSING_01 (post-fix)                REPRODUCED  (arm agreement alone, uncritically accepted)
GROUND_TRUTH_CONSISTENCY_01              GROUND_TRUTH_CONTRADICTED  (agreement checked against what actually happened historically)
```

No outcome in that sequence was a regression from the one before it, read correctly: each one is what the
evidence available at that moment actually supported, and each successive fix removed a specific,
named reason the prior label overclaimed or underclaimed. `GROUND_TRUTH_CONTRADICTED` is not a demotion
of babel-loader's status — it is the first label in this sequence that is actually defensible against the
recorded historical fact.

## What remains open, exactly as scoped

- **Why** the contradiction exists is still undiagnosed by `classify()`, deliberately. The determinism
  gate (`FLOATING_DEPENDENCIES` for this exact cell, established at `5539155`) is the standing candidate
  explanation, not yet wired to anything that would confirm it automatically.
- The harness's TAP-parsing fix and the ground-truth-consistency fix are both now real and load-bearing;
  neither retroactively changes any earlier evidence document, which stay as recorded.
