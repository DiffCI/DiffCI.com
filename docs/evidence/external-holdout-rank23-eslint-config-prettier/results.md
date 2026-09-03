# Fresh mechanical holdout, rank 23 — `prettier/eslint-config-prettier`

Genuinely untouched by `ENGINE_COVERAGE_01` item 1's design: `DEPENDENCY_BASIS_TIME_BOXED` was frozen
(`e8cc81b`, implemented `165a9d1`) before this repository was ever selected or looked at. Selection
continued the exact frozen `CI_REPRODUCTION_05` frame from rank 23 (see
`docs/evidence/external-engine-bridge-01-first-pilot-screening.json` for ranks 23–27: two rejected as
not transcribable, two rejected at R2, rank 27 qualified). Reference plan hand-transcribed and frozen
(`d8ae8ba`) before any engine run.

**Commit provenance, checked explicitly per direction:** the repository's live HEAD was pre-recorded
immediately before triggering the engine run — `bd6e6171434c7b34dec3dd0f325aab792c126ec6`, identical to
the plan's own pinned commit. No live-HEAD-vs-frozen-plan drift affects this result, unlike eslint's
rehearsal.

## Two separate measurements, as directed

**1. Was `DEPENDENCY_BASIS_TIME_BOXED` exercised?** **No.** The repository has a committed `yarn.lock` —
`DEPENDENCY_BASIS_PINNED` is satisfied via the existing, unchanged mechanism, so the new either/or slot
never reaches its second alternative. This holdout provides **no fresh generalization evidence for item
1** specifically. It was not selected to produce this outcome, or any other — checked only after R1/R2/R4
already qualified the candidate, per the explicit instruction not to optimize selection for item-1
applicability.

**2. The overall external-reproduction outcome: `REFUSED`, for a reason unrelated to dependency pinning.**

```
outcome: REFUSED
reason: the engine did not mark the path executable, so the inference arm executed nothing:
        TEST EXISTS but 1 causal prerequisite(s) could not be established:
        test-osubuntu-latest-node22-install-1 (this prerequisite's condition could not be evaluated,
        so whether it runs is unknown)
```

The reference arm ran flawlessly — all 7 steps exit 0, two real Jest suites (377 tests, then 455 tests,
0 failures each). The inference arm refused because one step's condition,
`if: matrix.node == 16 || matrix.node == 18` (the "Downgrade for Node" step, correctly irrelevant at node
22), could not be evaluated.

**Root cause, characterized precisely, not guessed** — read (read-only) directly against
`src/ci-inference/expression.ts`'s `evaluateCondition`: its `COMPARISON` regex models a single equality
or inequality against a literal (`<left> == <right>` or `<left> != <right>`) and nothing else. A compound
boolean expression combining two comparisons with `||` does not match that shape at all, so it falls
through to the `UNRESOLVED` branch — "only equality and inequality against a literal are modelled; the
path stays non-executable rather than assuming the step is skipped." This is exactly `DEFECT 29`'s own
discipline working as designed (an unresolved condition is never silently treated as `false`) — the
engine is refusing honestly, not misbehaving. It surfaces a genuinely new, distinct limitation: **compound
boolean expressions (`||`/`&&`) in step conditions are not modelled at all**, separate in kind from every
item already in `ENGINE_COVERAGE_01`'s queue (dependency pinning, bare-script TEST recognition, container
parity, parser coverage).

## What this does and does not establish

Per direction: **this failure is preserved, not repaired.** It is not added to `ENGINE_COVERAGE_01`'s
queue, not scoped into a new item, not touched. It is recorded as real, useful external-engine evidence —
a fifth distinct coverage gap, found by the same unbiased mechanical process, on a repository selected
without any regard to what it would expose.

Because item 1 was never exercised here, this result says nothing about whether
`DEPENDENCY_BASIS_TIME_BOXED` generalizes beyond eslint and chalk. That question remains open. It does,
however, extend the same conclusion the four-candidate pilot already supported: the external
selection/transcription/execution/evidence machinery keeps producing honest, unengineered outcomes on
repositories it has never seen, whatever those outcomes turn out to be.
