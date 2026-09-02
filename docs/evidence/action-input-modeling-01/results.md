# ACTION_INPUT_MODELING_01 — implemented, verified, adjudicated against the frozen criteria

Implements `docs/action-input-modeling-01-plan.md`. Sequence followed exactly as directed: isolated
prerequisite fix → feature implementation → synthetic/unit tests → full suite → the real pinned jest
repository → all five regression repositories, real harness. Source packed fresh
(`sources/diffci-c53e144a54b49894.tgz`, identical across all five runs), agent unchanged.

## What was built

- **Prerequisite** (separate commit, not counted as this phase's evidence): fixed a pre-existing,
  unrelated bug — `declaredPrerequisites`'s `carriesCommand` regex contained literal U+0008 backspace
  bytes instead of `\b` escapes, unconditionally unsatisfiable since written.
- **`MODELLED_COMMAND_INPUT`**: one entry, `"nick-fields/retry": "command"`. Fails closed by construction
  — an action absent from this map, or a listed action's `with:` block missing the exact named key,
  produces no operation.
- **`evidence.ts`**: `workflow.step.with` facts now also carry `attributes.value` (the raw input value,
  additive), evidence pointing at the value's own line where findable, and step conditions (`if:`) are now
  captured uniformly for `uses:` and `run:` steps alike (previously `uses:`/`with:` facts silently never
  carried a condition at all).
- **`infer.ts`**: a job's `run:` and eligible `uses:` steps are merged into one list, sorted by true
  declared step order, before becoming operations — a modelled action's extracted command goes through the
  identical `renderCommand` → `purposeOfLine` → `argvOf` pipeline every `run:` line already crosses.

## Adjudicated against the six frozen criteria, literally

**1. `nodejs.yml#test-runtime-vm-modules-node-version22.x` gains `TEST` in `provides`.** Confirmed against
the real pinned jest repository, both locally (`collectEvidence`+`inferPipeline`) and in the real
container's `reproduction.json`: `provides: ["BUILD", "INSTALL", "TEST"]`. **PASS.**

**2. Provenance is inspectable.** The resulting operation's evidence:

```
nick-fields/retry@ad984534de44a9489a53aefd81eb77f87c70dc60 with.command: yarn jest-runtime-vm-modules-ci --max-workers ${{ steps.cpu-cores.outputs.count }}
```

at `.github/workflows/nodejs.yml:181` — the exact real line. Action, pinned ref, input key, and original
value are all present in one place. **PASS.**

**3. Existing `run:` inference is provably unchanged.** Full suite 1895/1895 (1892 baseline + 3 new
tests), `tsc --noEmit` clean, no existing assertion touched. eslint's refusal reason is byte-for-byte
identical to `REGRESSION_02`'s frozen baseline, confirmed both locally and via the real container. **PASS.**

**4. Fail-closed, proven by fixture, not merely asserted.** Two dedicated tests: an unlisted action's
`with.command` produces zero operations; `nick-fields/retry` present but missing the `command` key (only
`timeout_minutes`/`max_attempts`) also produces zero operations. **PASS.**

**5. The other four repositories acquire zero new or changed operations.** Confirmed locally (none of
eslint/webpack/babel/babel-loader reference `nick-fields/retry` at all) and via the real container:
webpack's, babel's, and babel-loader's refusal/outcome reasons are byte-for-byte identical to
`REGRESSION_02`'s frozen baseline. **PASS.**

**6. Whether jest's headline outcome moves — reported as its own fact.** It does **not** move:

```
outcome: PARTIAL_REPRODUCTION
reason: both arms ran a suite but they are not equivalent: reference 581/0 vs inference 746/0
testPlan.jobId: nodejs.yml#test-leak
```

Exactly as predicted before implementation: `test-runtime-vm-modules-node-version22.x`'s new operation
carries `executionRepresentation: "UNRESOLVED"` (the `${{ steps.cpu-cores.outputs.count }}` expression is
`UNSUPPORTED_EXPRESSION`, an explicitly out-of-scope `steps.*` gap) and one blocked operation;
`test-leak` remains fully executable at zero blocked operations; `planForPurpose`'s "fewest blocked wins"
tie-break legitimately still selects `test-leak`. This is not a shortfall of this phase — it is the
predicted, correct separation of two distinct mechanisms holding under real execution:

- **Mechanism 1 (evidence invisible at the inference boundary) — this phase — succeeded.** The operation
  that did not exist before now exists, correctly represented, correctly NOT claimed executable.
- **Mechanism 2 (multiple visible candidates, wrong one selected by policy) — webpack's
  `WRONG_JOB_TARGETED` — remains completely untouched,** and correctly so: nothing in this phase's design
  or implementation reaches `planForPurpose`.

**PASS**, read correctly: this is not "jest still fails," it is the two mechanisms demonstrated as
genuinely separable under real, both fixed and unfixed evidence in the same run.

## What this closes and what remains

Closes `ACTION_INPUT_MODELING_01` as scoped. Two things remain, exactly where they were left before this
phase, untouched by design:

- `WRONG_JOB_TARGETED` (webpack's mechanism, and now demonstrably jest's *residual* mechanism too, once
  mechanism 1 is fixed) — job-target selection correctness, its own future scope.
- `steps.<id>.outputs.<name>` expression resolution — a separate, materially different capability.
- `TAP_PARSING_01` — babel-loader's harness-side TAP-output parsing gap, still open, still next in the
  user's stated sequence after this phase.
