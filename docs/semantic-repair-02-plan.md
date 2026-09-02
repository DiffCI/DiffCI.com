# FROZEN — SEMANTIC_REPAIR_02

**Written before a single line of the repair.** The predictions below are recorded now, exactly as
`semantic-repair-01-plan.md` did, because after the repair I would be grading my own work against the same
adjudication I fixed against.

## Where this comes from

`REGRESSION_01` (`docs/evidence/regression-01/results.md`) reran the frozen five against
SEMANTIC_REPAIR_01. `docs/evidence/regression-01/adjudication.md` then traced every non-eslint refusal back
to its actual cause rather than reading the outcome label alone, and found **three separate, falsifiable
defects and one new evaluation axis** — not one amorphous "inference is imperfect":

| repository | what adjudication established | category |
|---|---|---|
| jest | one phantom script block is the sole cause of refusal | command-classification defect |
| babel | one phantom script block, plus one genuine, verified, unmodelled cross-job artifact dependency | one defect + one legitimate model boundary |
| webpack | TEST purpose is now correctly present on all 39 `integration-*` instances (defect 31 does not reproduce), but the planner's "fewest blocked job wins" policy — an executability heuristic, not a ground-truth matcher — selects `basic` instead of `integration` | new axis, not a defect on the existing scale: `WRONG_JOB_TARGETED` |
| babel-loader | its real test script (`test-only`) never receives TEST purpose because `SCRIPT_NAME_PURPOSE`'s regex only matches colon-namespaced names | purpose-recognition defect, independent of the `FLOATING_DEPENDENCIES` determinism finding |
| eslint | refusal remains justified against the same, independently-verified cited requirement | control — held |

This document freezes the repair for the first two rows plus the naming-policy question the third partly
depends on. **Webpack's `WRONG_JOB_TARGETED` finding is deliberately excluded from this repair** — see
below.

## The architectural principle, not the token list

The obvious-looking fix — teach `infer.ts:56`'s `SCRIPT_RUN` regex to exclude `--frozen-lockfile`,
`--immutable`, `install`, `link` — is exactly the substring-patching failure mode SEMANTIC_REPAIR_01 spent
six layers repairing elsewhere in this same engine. It would produce a correct jest, a correct babel, and
the *next* yarn/npm/pnpm flag or built-in this list doesn't yet name.

**Two classifiers currently answer "is this a script invocation?" independently for the same command
text**, and disagree:

- `purpose.ts`'s `purposeOfLine` (`PACKAGE_MANAGER` + `INSTALL_SUBCOMMAND`, `purpose.ts:75,150-156`) — the
  correct one; it already treats `yarn --immutable`, `yarn install`, and a bare `yarn` as `install`, and
  correctly leaves `yarn link webpack` at `unknown`/`NONE` rather than guessing.
- `infer.ts:56`'s `SCRIPT_RUN` regex, consulted independently to decide whether to call `resolveScript()`
  and populate the causal reference graph. It has no `INSTALL_SUBCOMMAND` exclusion and no built-in-command
  awareness, so it resolves `--frozen-lockfile`, `install`, and `link` as script names, correctly finds no
  such script, and blocks an otherwise-executable operation on that basis.

**The invariant to establish:** an operation may only carry `SCRIPT_REFERENCE` semantics — only
`resolveScript()` may be called on it at all — once the command classifier has itself determined the
command *is* a package-manager script invocation and named the script. `infer.ts` must consume that
determination, never re-derive it by re-parsing the same line with a second, disagreeing rule. Concretely:
the script name passed into `resolveScript()` should come from `purposeOfLine`'s own resolution path
(where a `scriptName` is already computed at `purpose.ts:160`), not from an independent regex match at the
call site in `infer.ts`. This is an extraction of one already-correct piece of logic to a second consumer,
not a rewrite of either file's core reasoning.

**No repository-specific fixes.** Not "handle `install`", not "special-case `link`". The rule is about
package-manager command syntax in general, unnamed to any of the three repositories that happen to exercise
it — the same standard `semantic-repair-01-plan.md` set and this repair inherits unchanged.

## The naming-policy question, asked before any regex is touched

`babel-loader`'s refusal is not downstream of the shared-classifier fix — it is `SCRIPT_NAME_PURPOSE`'s
`/^test(:|$)/i` pattern (`purpose.ts:80`) failing to match `test-only`, a hyphen-namespaced script name.
Widening the regex to match `test-*` is not agreed here, because nothing in the codebase currently states
*what evidence* should make a declared script name TEST-like, only a pattern list nobody has re-derived
from a rule. Before any pattern changes:

1. State the rule a script name must satisfy to establish TEST purpose by name alone — `SCRIPT_NAME` is
   already the weakest basis (`purpose.ts:26-29`, "acceptable only for a script the repo declares"; a name
   proves nothing about a script that doesn't exist). What separates `test-only`, `test-unit`,
   `test-data`, `test-build`, and `test-helper`? Only some of those are genuinely test-purpose scripts by
   ecosystem convention; a rule that admits `test-*` wholesale trades one narrow gap for a different false
   positive.
2. Re-examine the existing colon form (`test:coverage`, tested at `purpose.test.ts:59-66`) against
   whatever rule is decided, rather than assuming it is already correct because it has a passing test.
3. Only then decide the pattern (or a different mechanism entirely — e.g. requiring the script body, once
   resolved, to itself classify as `test`/`unknown` rather than trusting the name at all for ambiguous
   cases).

This step produces a design decision, not code, and is sequenced before the babel-loader regression check
below.

## Explicitly out of scope — webpack `WRONG_JOB_TARGETED`

`planForPurpose`'s "fewest blocked operations wins" tie-break (`jobs.ts:104-116`) is unchanged by this
repair. It is a real, separate problem — an executability heuristic standing in for a job-selection
correctness question it was never designed to answer — and deserves its own design effort, not a fix
bundled into a repair aimed at command classification. Two things follow:

- This repair must not touch `planForPurpose`'s selection logic, even incidentally.
- If the shared-classifier fix changes any job's blocked-operation count enough that `planForPurpose`
  starts selecting a *different* job for TEST purpose on any of the five repositories — including
  webpack — that is a side effect to report, not a silent improvement to accept. `WRONG_JOB_TARGETED`
  is not considered addressed by this repair under any outcome.

## Repair sequence, frozen

```
shared package-manager command semantics (the extraction)
  → jest regression check (single-cause; predicts the cleanest outcome)
    → babel regression check (mixed-cause; predicts a persisting, narrower refusal)
      → test-purpose naming policy (design decision, no code yet)
        → babel-loader regression check (depends on the policy decision above)
          → [separate, later, its own frozen plan] job-target correctness for webpack
```

Jest before babel because jest isolates the shared-classifier change with nothing else on its causal path;
babel adds the negative-regression discipline once the simpler case is confirmed. Babel-loader is
last of the four because it depends on a decision this document does not make.

## Pre-registered expected movements — frozen before any repair

| repository | before (`REGRESSION_01`) | expected after | what it tests |
|---|---|---|---|
| eslint | `REFUSED` / `CORRECT_REFUSAL` | **unchanged** | control — must NOT move; if it does, stop and diagnose before reading anything else |
| jest | `REFUSED`, sole cause the phantom `script-34` block | phantom block gone (`test-leak-install-0` shows `blockedBy: []`); genuine outcome — `REPRODUCED`, `DIVERGED`, or a *different* refusal — determined by execution, not assumed | the shared-classifier fix, isolated |
| babel | `REFUSED`, phantom `script-32` **and** genuine `download-artifact` block | phantom block gone (`test-node-version25-install-0` shows `blockedBy: []`); **refusal persists**, citing only the `actions/download-artifact@v8` edge | the negative-regression check — fewer blockers, same refusal, is the CORRECT result, not a partial failure |
| babel-loader | `REFUSED`, no job provides TEST | not predicted here — depends on the naming-policy decision, made after this freeze and before this repository's check runs | purpose-recognition, gated on a design decision |
| webpack | `REFUSED`, `basic` selected, 2 of 3 blockers phantom | **not touched.** `basic` remains selected (unless the side-effect condition above fires, which must be reported); its post-classifier-fix refusal reason is recorded for completeness, not scored | isolating what this repair does and does not claim |

**Failure conditions, stated in advance so they cannot be reinterpreted later:**

- Any repository reaching `REPRODUCED` through a plan whose causal path is still incomplete is an
  accidental success, recorded as a defect — unchanged from SEMANTIC_REPAIR_01.
- **Babel losing its `download-artifact` refusal** — claiming to understand or bypass the cross-job
  artifact dependency — after the shared-classifier fix is a **regression**, not progress. The fix must
  remove exactly the false edge and nothing else.
- **Eslint moving off its held refusal** is a regression, not progress, exactly as before.
- **Any change to webpack's selected job or blocked-operation accounting**, however small, must be stated
  explicitly rather than absorbed into "webpack improved" — this repair has no claim over
  `WRONG_JOB_TARGETED` in either direction.
- Reaching a clean result on jest and babel does **not** by itself license widening the babel-loader
  pattern without the naming-policy step above — increased acceptance is not the success metric here,
  stated once so it does not need restating per repository.

## What this repair does not do

- Does not implement job-target correctness for webpack.
- Does not add rows to the `CORRECT_REFUSAL`/`INCORRECT_REFUSAL` mechanical table
  (`docs/ci-reproduction-sample-01.md`) for the marketplace-action case `adjudication.md` recommended —
  that is a documentation decision independent of this code change, left open.
- Does not touch `planForPurpose`, `causal.ts`, or any file outside the command-classification path and
  (once decided) the test-purpose naming pattern.
