# FROZEN — ACTION_INPUT_MODELING_01

**Written before a single line of the repair.** Scoped, not yet implemented, per the same discipline
`semantic-repair-01-plan.md` and `semantic-repair-02-plan.md` used — recorded now so this phase is graded
against what it predicted, not against what implementing it turns out to be convenient to claim.

## Where this comes from

`REGRESSION_02`'s freeze (`docs/evidence/regression-02-full/results.md`) left jest's `PARTIAL_REPRODUCTION`
open, root-caused to `nick-fields/retry`, a third-party retry-wrapper action whose `with.command` input
carries jest's real test invocation:

```yaml
- uses: nick-fields/retry@ad984534de44a9489a53aefd81eb77f87c70dc60
  with:
    timeout_minutes: 10
    max_attempts: 3
    retry_on: error
    command: yarn jest-runtime-vm-modules-ci --max-workers ${{ steps.cpu-cores.outputs.count }}
```

`infer.ts` only turns `workflow.step.run` facts into operations; a command living in an unmodelled
action's `with:` block is invisible to `purposeOfLine` no matter how correct that function is. This is
the architectural gap this phase closes — narrowly, per direction: a recognized action with an explicitly
modelled command-carrying input, not generic interpretation of arbitrary `with:` values.

## Two things the investigation found, before any design

**1. The evidence already exists; nothing consumes it.** `evidence.ts`'s `workflowFacts()` already
records every `with:` key AND value as a `workflow.step.with` fact (`value: "command=yarn jest-runtime-..."`,
`attributes: {input: "command", action: "nick-fields/retry@..."}`) — its own docstring names this exact
case as the reason it exists ("jest's test command is `with.command` of `nick-fields/retry`... recording
the keys is what later lets a causal edge be marked unresolved instead of being absent"). No file anywhere
reads `"workflow.step.with"` facts. This phase's job is almost entirely consumption, not new collection —
the one gap is that the fact's `.value` is a combined `"key=value"` string; `attributes.value` (the raw,
unprefixed string) does not yet exist and is a one-line additive change to emit alongside it.

**2. A real, pre-existing, unrelated bug sits in the function this phase extends.**
`infer.ts`'s `declaredPrerequisites` (the code that currently turns an unmodelled action into an ARTIFACT
or ACTION_EXECUTION prerequisite) has never correctly distinguished the two: `carriesCommand = keys !==
undefined && /(command|run|script|args)/.test(keys)` — read normally — should match `nick-fields/retry`'s
`withKeys` (`"timeout_minutes,max_attempts,retry_on,command"`), which visibly contains `"command"`. It
doesn't, because the regex literal in the source file contains two **literal U+0008 backspace bytes**
(`/`, then byte `0x08`, then `(command|...)`, then `)`, then byte `0x08`, then `/`) instead of the
two-character escape `\b` — confirmed by reading the file's raw bytes, not its rendered text. A raw
control byte in a regex is a literal character to match, never satisfiable against an identifier list, so
`carriesCommand` has been unconditionally `false` since this code was written; every unmodelled action has
always been reported `ARTIFACT`, never `ACTION_EXECUTION`, regardless of its `with:` keys. Two more
instances of the same corrupted byte sit in a dead comment nearby (harmless — inert prose), suggesting a
mechanical mangling rather than a deliberate choice.

This bug is orthogonal to this phase's design — the fix below reads `workflow.step.with` facts directly
and does not depend on `carriesCommand`/`ACTION_EXECUTION` classification at all — but it is real, cheap,
and sits in the exact function this phase's neighbourhood touches. **Fixed as its own, separate commit**,
with its own regression test (the corrupted bytes themselves as the thing a test asserts absent, mirroring
how this codebase already guards other dead/corrupted patterns), not folded into the feature commit.

## Design

**A curated, per-action allowlist — not a generic `with:` interpreter:**

```ts
/** Actions this engine recognises as carrying a command in one specific, named input. Adding an entry
 *  here is a claim about ONE action's documented contract, never a claim about `with:` keys in general -
 *  a key literally named `command` on an unlisted action stays exactly as unresolved as it is today. */
const MODELLED_COMMAND_INPUT: Record<string, string> = {
  "nick-fields/retry": "command",
};
```

Matched against the action's `owner/repo` prefix (before the `@ref`), mirroring `MODELLED_ACTION`'s own
matching style. Only ONE entry at launch — `nick-fields/retry` → `command` — because it is the only
case that turned up across all five frozen regression targets (checked: `actions/download-artifact`'s
`with.name` is a different capability, artifact identity not command extraction, and stays on its
existing, separate path).

**Fail-closed, explicitly, with a regression test proving it:** an action not in
`MODELLED_COMMAND_INPUT`, or a `with:` block on a listed action that doesn't have the exact named key,
produces **no operation** — falls through to today's `declaredPrerequisites` behaviour unchanged. A
fixture repo with an invented `some-org/some-action` step whose `with.command` (or `with.run`,
`with.script`) is `rm -rf /` must produce zero operations from it, asserted directly.

**Data flow, matching how a `run:` step already becomes an operation, not inventing a parallel path:**
for a job's steps, walk `workflow.step.run` AND `workflow.step.uses` facts together in their true
declared order (`attributes.step`, already captured on every fact, is the sort key — currently `runs` and
`uses:`-derived data are processed as two separate passes; this phase makes them one ordered walk so a
modelled command's position among real `run:` steps, and its dependency on whatever install step precedes
it, is genuine and not merely appended at the end). A modelled `uses:` step with a matching
`workflow.step.with` fact becomes a candidate operation exactly like a `run:` line: its extracted command
text goes through `renderCommand` (the SAME expression-rendering boundary every `run:` line already
crosses — `${{ }}` resolution, matrix substitution, the works), then `purposeOfLine`, then `argvOf` — the
identical pipeline, not a parallel one, so this phase adds a new SOURCE of command text, never a new way
of interpreting it.

**Provenance, preserved on the resulting operation, per direction:** the action's identity and pinned ref,
and which input carried the command, travel with the operation the same way any other operation's
`evidence: EvidenceRef[]` already carries file/line — evidence text should read as `<action>@<ref> with.
<key>: <command>` rather than bare command text, so a receipt can show this came from an action's input,
not a `run:` line, without inventing a new schema field.

## What this phase explicitly does NOT attempt

**`steps.<id>.outputs.<name>` expression resolution.** `nick-fields/retry`'s extracted command references
`${{ steps.cpu-cores.outputs.count }}` — `src/ci-inference/expression.ts` has no handling for the `steps.*`
context at all (confirmed: zero matches for `steps\.` in that file). Building that is a materially
different, separate capability (cross-step output dependency tracking, the same *shape* of problem as
`matrix.*` expansion or `secrets.*` handling, each its own prior effort in this codebase) and is
out of scope here. **Predicted, not discovered later:** the resulting operation for
`nodejs.yml#test-runtime-vm-modules` is expected to show `purposeBasis: SCRIPT_BODY` (or
`EXECUTABLE_POSITION`, depending on how the extracted line resolves through `purposeOfLine`) —
i.e. genuinely correct TEST purpose — but `executionRepresentation: "UNRESOLVED"`, because the
`steps.cpu-cores.outputs.count` expression cannot render. This is the SAME two-axis shape webpack's
`basic-unknown-1` already has (`purpose TEST + execution UNRESOLVED`) and is the CORRECT, honest
representation — not a defect to fix here, not a shortfall to paper over.

**Job-target selection.** Making `test-runtime-vm-modules` a genuine `TEST`-providing candidate does
**not** by itself change which job `planForPurpose` selects. `test-leak` remains fully executable
(0 blocked operations); `test-runtime-vm-modules` will have exactly one `UNRESOLVED` operation (the
`steps.*` gap above) — under the existing "fewest blocked operations wins" tie-break, `test-leak` is
expected to **still win**, and jest's overall regression outcome (`PARTIAL_REPRODUCTION`, job `test-leak`)
is **not** predicted to change from this phase alone. This is deliberate: mechanism 1 (evidence invisible
at the inference boundary — this phase) and mechanism 2 (multiple visible candidates, wrong one selected
by policy — webpack's `WRONG_JOB_TARGETED`) must not share a fix, and this phase's success is judged on
whether the graph now correctly represents jest's real test step, not on whether the regression's headline
outcome moves.

## Acceptance criteria — frozen before implementation

1. `nodejs.yml#test-runtime-vm-modules-node-version22.x` gains `TEST` in `provides`, verified against the
   real pinned jest repository, not only a synthetic fixture.
2. The resulting operation's `evidence` names `nick-fields/retry@ad984534...` and the `command` input —
   provenance is inspectable, not silently absorbed into an ordinary-looking operation.
3. Existing `run:`-derived inference is provably unchanged: full suite green with no modified assertions
   in any existing test, and eslint's refusal reason stays byte-for-byte identical to
   `REGRESSION_02`'s (`docs/evidence/regression-02-full/eslint/reproduction.json`).
4. A fail-closed regression test: an unlisted action's `with.command`/`with.run`/`with.script`/`with.args`
   produces zero operations.
5. Re-run locally (via `collectEvidence`+`inferPipeline` against the same pinned clones already used
   throughout this thread) against all four OTHER frozen targets — eslint, webpack, babel, babel-loader —
   and confirm zero new or changed operations, since none of them reference `nick-fields/retry`.
6. Stated, not assumed: whether jest's `PARTIAL_REPRODUCTION` outcome changes in a subsequent real
   harness run is reported as its own, separate fact — a "no" is not a failure of this phase per criteria
   1-5, and a "yes" would itself need explaining given the job-selection prediction above.

## Sequence

```
fix the corrupted-regex bug (separate, small, standalone commit)
  → MODELLED_COMMAND_INPUT + ordered run:/uses: walk + provenance (this phase's implementation)
    → verify locally against jest's real repo (criteria 1-2) and the fail-closed fixture (criterion 4)
      → full suite + eslint byte-identity check (criterion 3)
        → verify locally against the other four real repos, zero new operations (criterion 5)
          → [separate, later] real harness rerun of the five, to observe (not assume) criterion 6
```
