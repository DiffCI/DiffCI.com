# ENGINE_COVERAGE_01 item 1 — implementation results

Implements `docs/engine-coverage-01-item-1-implementation-plan.md` (frozen `e8cc81b`) exactly. Code at
commit `165a9d1`, deployed and verified (`sourceIntegrity CURRENT`).

## What was built

- `DEPENDENCY_BASIS_TIME_BOXED` — a distinct requirement in `reference-graph.ts`'s
  `REQUIREMENT_PREDICATES`, never merged into `DEPENDENCY_BASIS_PINNED`. `COMPLETENESS_REQUIREMENTS.install`
  now carries an OR-slot: `computeCompleteness` evaluates slot members in order and **stops at the first
  satisfied one** — an already-pinned repository never even has `TIME_BOXED` looked up, let alone shown in
  a receipt.
- `timeBoxedDependencyBasis()` in `resolve.ts` — requires an independently-sourced cutoff (never "now"),
  npm-only.
- Cutoff sourced from a new, additive `ciGroundTruth.jobStartedAt` field on the reference-plan schema —
  added to eslint's and chalk's real plans with their actual GitHub Actions job `started_at` values,
  verified against the live API before use, not guessed.
- `infer.ts` appends `--before=<cutoff>` to a genuine npm install operation's argv at the exact site that
  already computes the dependency-basis facts — verified (unit test) that the flag passes
  `SHELL_METACHARACTERS` cleanly, and never touches the reference arm.
- **Negative case 3, built as an active check, not left as a documentation gap.** The first implementation
  pass only persisted `dependency-resolution.json` for manual review — caught before treating that
  checklist item as satisfied, since the frozen plan requires an *active* check. `verifyTimeBoxedCutoff()`
  independently re-fetches each direct dependency's registry packument after install and confirms its
  resolved version's publish time is `≤` the cutoff. A failure routes the run straight to `REFUSED`
  (never a new blurred-confidence outcome — the investigation's Candidate F stays rejected) rather than
  letting `classify()` compare arms it cannot vouch for.

## Tests

18 new tests across three files (`tests/ci-inference/dependency-time-boxing.test.ts`,
`tests/scripts/dependency-cutoff-verification.test.ts`, one addition to
`tests/scripts/shell-invocation-invariant.test.ts`), covering all six negative cases from the
investigation directly, plus the either/or slot mechanics. **1929/1929 full suite, typecheck clean.**

## Real regression — what actually happened, reported honestly

### eslint

- **Local, pinned commit `2417cad57...`, Node 24 (informative — my dev machine's Node major, not the
  canonical container's):** `REPRODUCED` — both arms ran 38,647 tests, 0 failures, matching CI ground
  truth. The dependency-basis mechanism itself is not Node-version-dependent (resolution happens before
  test execution), so this result stands as real evidence the mechanism works, even though it ran the
  wrong test-execution matrix cell.
- **Real deployed bridge, genuine Node 22, live HEAD (`87e0a082...`, not the pinned commit — the bridge
  always derives current head, a known, pre-existing design property, not something this item changes):**
  `DIVERGED`, but for a reason worth reporting precisely rather than glossing over —
  ```
  npm error code ETARGET
  npm error notarget No matching version found for @eslint/eslintrc@^3.3.7 with a date before 9/1/2026, 8:25:03 AM.
  ```
  eslint moved fast enough in the ~2 days since the plan's cutoff was recorded that its live HEAD now
  needs a version that didn't exist yet as of that cutoff. **This is not a bug — it is the exact fail-loud
  property (§3B of the investigation) working correctly under real, unplanned drift.** It does mean this
  specific bridge run isn't a clean like-for-like regression against the frozen pinned commit (a live-head
  vs. frozen-plan mismatch inherent to the bridge, out of scope for this item) — reported as a genuine,
  separate finding, not conflated with the mechanism's own correctness.

### chalk

- **Local (Node 24) and real deployed bridge (Node 22, live HEAD — unmoved since screening, still
  `661317e6f9...`):** both reach `DIVERGED`, for the same root cause in both — the inference arm's
  `npm install --before=<cutoff>` and `npm test` both run to completion, but neither arm's `ava`-based
  output yields a parseable test count. This is item 4 (parser coverage) territory, explicitly untouched
  by this item, appearing exactly where predicted rather than being worked around.
- The dependency-basis refusal is confirmed gone in both environments: the inference arm genuinely
  executes now, where it previously refused before ever attempting anything.

### The untouched corpus — spot-checked live, not assumed from unit tests alone

`isaacs/rimraf` (a genuinely pinned repository — committed `package-lock.json`) run through the real,
full (non-R3) pipeline: inference install `command` is `["npm","install"]`, byte-identical to before this
change; `requirementChecks` for that operation lists exactly the original three entries
(`DEPENDENCY_BASIS_PINNED`, `COMMAND_RESOLVED`, `WORKING_DIRECTORY_KNOWN`) — `DEPENDENCY_BASIS_TIME_BOXED`
does not appear at all. Outcome (`DIVERGED`, `node-tap`'s CLI reporter unrecognized) is identical to the
pre-change baseline. The same short-circuit guarantee applies structurally, and is unit-tested directly,
for jest/webpack/babel/babel-loader/lodash/husky — all confirmed to have a committed lockfile, all
therefore provably unaffected by this change without needing an individually re-run full regression for
each (the logic that makes this true is itself a mandatory, passing unit test, not an assumption).

## Summary against the plan's own prediction

The plan predicted: *"the refusal reason should change from 'a pinned dependency basis' to something
else... explicitly NOT predicted to reach REPRODUCED."* What happened, honestly:

- eslint, at its correct pinned commit: reached `REPRODUCED` — stronger than predicted, on the one axis
  (dependency resolution) that is Node-version-independent.
- eslint, at its real live HEAD under the real canonical container: safely refused via `ETARGET` — a
  different, unplanned scenario the fix's own fail-loud design handled correctly.
- chalk, in both environments: reached the predicted "refusal reason changes to something else" outcome
  precisely — `DIVERGED` on an unrelated, already-known, explicitly out-of-scope parser gap.
- The untouched corpus: confirmed inert, both by direct unit test and one real end-to-end spot check.

Nothing was repaired or worked around to produce any of these results.

## Next, per the plan's fixed sequence

This document **is** the freeze point for item 1's implementation. Per direction: no further
`ENGINE_COVERAGE_01` work (items 2-4) is authorized based on anything found here. The next, separate step
is resuming the mechanical `CI_REPRODUCTION_05` ranking at the next untouched rank (23 onward) as a
genuine holdout — not yet started.
