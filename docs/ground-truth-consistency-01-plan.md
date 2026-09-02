# FROZEN — GROUND_TRUTH_CONSISTENCY_01

**Written before a single line of the repair**, per the same discipline every phase in this thread has
used. Scoped from `docs/evidence/tap-parsing-01/results.md`'s finding: `classify()` returned `REPRODUCED`
for babel-loader with both arms showing 2 failures each against a recorded `"success"` ground truth — a
label the code's own written contract (`docs/ci-reproduction-sample-01.md`: REPRODUCED means "materially
equivalent to the reference arm **and** consistent with CI ground truth") does not actually support.

## The central invariant

> Agreement between DiffCI and the baseline is necessary for `REPRODUCED`, but agreement alone is
> insufficient when both executions contradict the recorded ground-truth outcome.

## Tracing the contracts before choosing anything — done, before this freeze

**1. Who else reads `classify()`'s output?** Exactly one runtime path: `validation-shard-do.ts`'s
`collectCiReproduction` uploads `reproduction.json` verbatim to R2 — it never parses `outcome` at all
("the reproduction verdict is computed by the harness rather than by this collector"). No script anywhere
counts `"N of 5 REPRODUCED"` or gates anything programmatically on the string. The one place `REPRODUCED`
is a load-bearing decision is **prose**: `docs/ci-reproduction-sample-01.md`'s terminal rule ("≥ 1 genuine
`REPRODUCED` → those repositories become the initial substrates for `CI_OPTIMIZATION_01`"), applied by a
human reading a hand-built table. **Conclusion: introducing a new `Outcome` value has no runtime call site
to update beyond `classify()` itself and its test file** — safe to do, and the only place a wrong
`REPRODUCED` would have caused real harm is a human trusting the label in a future decision, which is
exactly what happened once already (this finding) and must not happen again quietly.

**2. Does any of the seven existing outcomes already fit?** No, read against all seven:

- `PARTIAL_REPRODUCTION` fires only when the **two arms disagree with each other** — the opposite input
  shape from babel-loader's case (arms agree with each other, disagree with ground truth). Reusing it
  would falsify its own existing contract.
- `UNVERIFIABLE` fires only when ground truth is **absent or unusable**. Babel-loader's ground truth is
  usable (`"success"`) — reusing `UNVERIFIABLE`'s reason text ("no usable CI ground truth") would be
  false.
- `DIVERGED` is about whether/what ran, not whether the result matches reality.
- `ENVIRONMENT_INADEQUATE` is a structural check (environment signals) that already runs earlier in the
  same branch and would already have intercepted genuine environment noise before reaching this point.

**None of the seven cover "arms agree with each other, ground truth is usable, arms contradict it."** A
new terminal value is genuinely required, not a mislabelling of an existing one.

**3. The determinism gate — deliberately NOT wired in.** `assessDeterminism()`
(`scripts/determinism-gate.ts`) has exactly one caller in the entire repo: its own test file. Nothing in
`classify()`'s call path invokes it, and no artifact stores a `DeterminismVerdict` keyed by repository for
`classify()` to read even if it wanted to. **This phase does not change that.** Per direction: execution
consistency with ground truth and environment/determinism confidence are two independent facts, and
`classify()` should establish the first without assuming or asserting the second — a
`GROUND_TRUTH_CONTRADICTED` result does not claim to know *why* the contradiction happened (floating
dependency, genuine flake, or something else); it states plainly *that* it happened, and leaves diagnosis
to whoever reads it next, the same way `UNVERIFIABLE` already declines to guess.

**4. Symmetry, checked rather than assumed.** The current `usable` check already treats
`"success"`/`"failure"` identically, and grepping every doc and test confirms the gap is equally
unaddressed in both directions — no test exercises `conclusion: "failure"` at all today. But the two
directions are not equally *interpretable*, and the reason string must say so rather than presenting a
false equivalence:

- **`"success"` contradicted by observed failures** (babel-loader's actual case): given the commit is
  pinned and the source cannot have changed, the most likely explanation is environmental/dependency
  non-determinism between the historical run and today's. Comparatively low-stakes to leave unexplained —
  it says "something about the environment differs," not "the engine is wrong."
- **`"failure"` contradicted by a clean run (zero failures in both arms)** is a different and more
  concerning shape: it is equally consistent with benign non-determinism (a flaky historical failure that
  didn't recur) **and** with a silent DiffCI-side correctness problem (the reproduced path not actually
  exercising whatever failed historically — wrong job, a skipped step, a truncated matrix). Arm-to-arm
  agreement on a clean run cannot distinguish these, and must not be reported as if it could.

Both directions return the same new outcome (the *structural* fact — arms agree, ground truth contradicted
— is identical), but the `reason` text is written differently per direction, carrying the asymmetric
caveat forward rather than flattening it.

## Design

One new value, added to `Outcome` (`scripts/ci-reproduction.ts:52-59`):

```ts
export type Outcome =
  | "REPRODUCED"
  | "PARTIAL_REPRODUCTION"
  | "REFUSED"
  | "DIVERGED"
  | "INFRASTRUCTURE"
  | "ENVIRONMENT_INADEQUATE"
  | "UNVERIFIABLE"
  | "GROUND_TRUTH_CONTRADICTED";
```

A new check inside the existing arm-agreement branch (`ci-reproduction.ts:514-536`), after the `usable`
check and before the unconditional `REPRODUCED` return:

```ts
if (refSuite && infSuite && refSuite.failures === infSuite.failures && refSuite.tests === infSuite.tests) {
  const usable = groundTruth && (groundTruth.conclusion === "success" || groundTruth.conclusion === "failure");
  if (!usable) { /* unchanged: UNVERIFIABLE */ }

  // GROUND_TRUTH_CONSISTENCY_01. Arm agreement is necessary, not sufficient. `failures` can be `undefined`
  // from a DIFFERENT parser than the one that supplied `tests` (countsOf and parseTestOutput are
  // independent) - treated as unknown, not as zero, the same "never assume" discipline this file already
  // applies everywhere else.
  if (typeof refSuite.failures !== "number") {
    return { outcome: "UNVERIFIABLE", reason: `both arms agree on ${refSuite.tests} tests, but neither reports a usable failure count, so consistency with ground truth cannot be checked` };
  }
  const cleanRun = refSuite.failures === 0;
  const consistent = groundTruth!.conclusion === "success" ? cleanRun : !cleanRun;
  if (!consistent) {
    return {
      outcome: "GROUND_TRUTH_CONTRADICTED",
      reason: groundTruth!.conclusion === "success"
        ? `both arms agree (${refSuite.tests} tests, ${refSuite.failures} failures) but CI ground truth ${groundTruth!.cell} recorded "success", which implies zero failures. The commit is pinned, so the source cannot explain this - check whether the environment (dependency resolution, toolchain) differs from what CI originally ran.`
        : `both arms agree (${refSuite.tests} tests, 0 failures) but CI ground truth ${groundTruth!.cell} recorded "failure". A clean run here does not by itself prove the reproduced path exercises whatever failed historically - verify independently rather than treating arm agreement as confirmation.`,
    };
  }
  // unchanged: REPRODUCED
}
```

Placed exactly where the existing check already sits — no other branch, no other line of `classify()`
touched.

## Pre-registered predictions and test matrix

| ground truth | arms agree? | failures | expected | why |
|---|---|---|---|---|
| `success` | yes | 0 / 0 | `REPRODUCED` | unchanged — every existing test of this shape must still pass |
| `success` | yes | 2 / 2 | `GROUND_TRUTH_CONTRADICTED` | **the babel-loader case** — the concrete fixture this phase is scoped around |
| `failure` | yes | 3 / 3 | `REPRODUCED` | new: the un-tested, previously-assumed-fine direction, now actually proven |
| `failure` | yes | 0 / 0 | `GROUND_TRUTH_CONTRADICTED` | new: the asymmetric case the plan calls out explicitly |
| absent / cancelled | yes | any | `UNVERIFIABLE` | unchanged |
| n/a | no (arms differ) | — | `PARTIAL_REPRODUCTION` | unchanged |
| either `failures` undefined | yes | — | `UNVERIFIABLE` | new, defensive — never silently treated as zero |

**The concrete babel-loader contradiction this phase is frozen around**: ground truth `"success"`,
reference arm 2 failures, inference arm 2 failures → must not mean `REPRODUCED`. Re-running the exact
frozen artifact (`docs/evidence/tap-parsing-01/babel-loader/reproduction.json`'s two `StepReceipt`s)
through the fixed `classify()` must produce `GROUND_TRUTH_CONTRADICTED`, not any other value.

## What this phase does not attempt

- Does not call `assessDeterminism()` from `classify()` or anywhere in the `ci-reproduction.ts` path.
- Does not persist a `DeterminismVerdict` into `reproduction.json`.
- Does not guess *why* a contradiction occurred (dependency drift vs. genuine flake vs. something else) —
  states the fact, leaves diagnosis separate, exactly as `UNVERIFIABLE` already declines to guess why
  ground truth is missing.
- Does not touch `PARTIAL_REPRODUCTION`, `DIVERGED`, `ENVIRONMENT_INADEQUATE`, `INFRASTRUCTURE`, or
  `REFUSED` — none of their branches are reachable from the code this phase changes.
- Does not retroactively re-label any already-frozen evidence document. `docs/evidence/tap-parsing-01/`'s
  `REPRODUCED` stays as recorded, exactly as babel-loader's earlier `DIVERGED`→`REPRODUCED` transition
  itself was reported as an observed fact rather than silently edited.

## Sequence

```
this freeze (done)
  → implement: Outcome value + classify() branch
    → tests/scripts/infrastructure-not-divergence.test.ts: extend with the full matrix above,
      including the two new-direction cases no existing test covers
      → full suite
        → the real, frozen babel-loader case: fresh execution against the real pinned repository
          → the five-repo regression, real harness
            → freeze evidence
```

Budget: a bounded classifier-semantic change with no new plumbing (confirmed by the tracing above) — not
expected to be a large effort, and does not block or extend any external-repository timeline.
