# TAP_PARSING_01 — real-harness verification, plus a significant downstream finding

Implements `docs/tap-parsing-01-plan.md`. Source packed fresh (`sources/diffci-d3347525afd6e3ae.tgz`,
identical across all five runs). Sequence followed exactly: fixtures + unit tests (already committed,
`1082043`) → full suite (1901/1901) → the five-repo regression, real harness. Raw artifacts under
`docs/evidence/tap-parsing-01/<repo>/`.

## The primary criterion — met

`countsOf()` now truthfully reads `tests: 66` out of babel-loader's real output. Both arms:

```
referenceArm  tests: 66  failures: 2  exitStatus: 1
inferenceArm  tests: 66  failures: 2  exitStatus: 1
```

Exactly the frozen fixture's own `# tests 66` / `# fail 2` footer, read correctly for the first time.
eslint's, webpack's, and babel's outcomes are byte-for-byte identical to the pre-fix baseline
(`docs/evidence/regression-02-full/`); jest's `PARTIAL_REPRODUCTION` numbers are unchanged (jest's output
was never TAP, so this fix could not and did not touch it). Zero side effects, confirmed against the real
container, not only the unit-level fixtures.

## The downstream fact, reported separately, per direction — babel-loader is no longer DIVERGED

```
outcome: REPRODUCED
reason: both arms ran 66 tests with 2 failures, matching CI ground truth
        Test - ubuntu-latest - Node 22, Babel 7, Webpack 5 = "success"
        (github actions job 92034086500)
```

Stated as directed: this is *observed*, not evidence that the parser change was correct — the parser
change is correct regardless of what `classify()` does with the number it now has.

## A significant, separate problem this observation surfaces — not fixed here

Read past the label. The recorded historical ground truth for this exact cell is `"success"` — the real
GitHub Actions job passed. **Both arms just ran, today, produced 2 failures each, exit status 1 — and
`classify()` still returned `REPRODUCED`.** Its criterion (`ci-reproduction.ts:511`) is:

```ts
if (refSuite.failures === infSuite.failures && refSuite.tests === infSuite.tests) {
  const usable = groundTruth && (groundTruth.conclusion === "success" || groundTruth.conclusion === "failure");
  ...
  return { outcome: "REPRODUCED", reason: `both arms ran ${refSuite.tests} tests with ${refSuite.failures} failures, matching CI ground truth ...` };
}
```

This checks that the two arms **agree with each other**, and that ground truth is **usable** (a real
success/failure conclusion exists, as opposed to `cancelled`/`skipped`). It never checks that the arms'
*actual failure count is consistent with* the ground truth conclusion — a `"success"` cell should imply
zero failures; this one has two, in both arms, and is still labelled a match.

This is precisely what `docs/semantic-repair-02-plan.md`'s determinism gate (`5539155`,
`scripts/determinism-gate.ts`) already exists to warn about: babel-loader's `yarn add -D webpack@5` is a
floating range, classified `FLOATING_DEPENDENCIES` at that commit. Today's registry resolves it to a
version published after the commit whose CI is being reproduced, and two tests that assert on webpack's
build-log content fail as a result — identically in both arms, because both arms install from the same
live, unpinned registry state. Arm-to-arm agreement here is not independent confirmation; it is the same
non-determinism affecting both arms the same way. **The gate's own verdict is never consulted by
`classify()`** — the two pieces of code were built separately (the gate is explicitly "harness-side,"
per its own docstring, "making dependency reproducibility an input to DiffCI's own confidence and refusal
is a later inference change, not made now") and nothing wires them together.

This is the same shape of gap `DEFECT 25`'s own comment, three lines above the code just quoted, warns
against for the *no-ground-truth* case ("arm-to-arm agreement is NOT reproduction... absent ground truth
the honest answer is UNVERIFIABLE, not a pass") — but for the case where ground truth *exists* and the
run contradicts it in a way both arms share. Was never exercised before this fix, because babel-loader was
always `DIVERGED` (no `tests` count at all) prior to today — the classify()-level gap could not have
manifested until the TAP parser gap that hid it was fixed.

**Not fixed here**, per direction. Flagged precisely: `classify()`'s `REPRODUCED` branch needs either a
failure-count-vs-ground-truth consistency check, or to consult the determinism gate's verdict for the
cell before returning `REPRODUCED`, or both. This is now a concrete, well-evidenced next scoping question
— name it before touching it, the same discipline every phase in this thread has used.
