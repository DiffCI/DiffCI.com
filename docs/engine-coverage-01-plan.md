# FROZEN — ENGINE_COVERAGE_01: bounded engine-coverage phase, scoped from an unbiased external baseline

**Written before any engine code for this phase is touched.** The baseline this plan is scoped from
(`docs/evidence/external-engine-bridge-01-first-pilot/`) is declared closed and unmodified as of this
freeze — nothing below retroactively changes what was observed there.

## The baseline, declared closed

Four mechanically-selected external repositories (`docs/evidence/external-engine-bridge-01-first-pilot-screening.json`,
continuing `CI_REPRODUCTION_05`'s own frame, ranks 12–22), three carried to a real bridge execution,
one (rollup) mechanically rejected at R2. All three executed candidates: `REFUSED`. Zero `REPRODUCED`.

| candidate | outcome | reference-arm finding | inference-arm finding |
|---|---|---|---|
| rimraf | rejected at R3 (screening) | `node-tap` CLI reporter unrecognized (suite ran clean, 782/782) | not reached |
| lodash | `REFUSED` | none (ran clean, once verified in the real Linux container) | unresolved TEST-path operation (`test-docs-unknown-4`) |
| husky | `REFUSED` | canonical container missing `time` (11/12 sub-tests ran) | bare `./test.sh` not recognized as TEST |
| chalk | `REFUSED` | none (ran clean) | missing pinned dependency basis — **repeats eslint's exact refusal** |

**The result this phase is scoped from, stated precisely:** the unbiased external pilot validated
DiffCI's evaluation and execution machinery (selection → independent frozen reference plan → live HEAD →
deployed execution → immutable, persisted result), while revealing that current engine coverage — not
the external bridge — is now the principal constraint on successful reproduction. This corpus is the
**pre-improvement baseline**. It is not touched by anything in this plan; it is what any future fix is
measured against.

## Priority-ordered investigation queue

Ordered by expected leverage, not by ease. Each item is an investigation to scope and freeze its own
narrower plan before code, per this project's standing discipline — this document authorizes
*investigating and scoping* item 1 next, not writing engine code yet.

### 1. Dependency-pinning gate — investigate first

The only **repeated** inference failure so far (eslint, chalk — independently selected, same mechanism:
`src/ci-inference/resolve.ts`'s `{ pinned: false, detail: "no lockfile and no packageManager field" }`,
surfaced through `reference-graph.ts`'s `"a pinned dependency basis (lockfile or packageManager field)"`
prerequisite). Chalk's reference arm completed both commands (`npm install`, `npm test`) with exit 0 —
proof that outright refusal excludes a real class of otherwise-executable CI, not proof that an unpinned
install is deterministic. **Do not weaken the safety invariant so an unpinned repository becomes
executable by assumption.** The question to investigate: can DiffCI establish an alternative
reproducibility basis for these repositories — potentially from CI/runtime evidence already available
(e.g., the exact resolved versions a real CI run installed, if recoverable) — without pretending an
unpinned `npm install` is deterministic when it structurally isn't.

### 2. TEST-purpose recognition

`purpose.ts` does not currently recognize an explicit, bare workflow test command (`./test.sh`) as
providing TEST. Husky is strong evidence this is worth fixing on principle, not as a repository-specific
exception: 11 of 12 real integration tests executed before the `time` utility was missing, while the
inference arm failed independently and for an unrelated reason. Scope as a *principled* recognition rule
(e.g., "a step whose `run:` is a direct, non-`npm run`, executable script path"), not a special case for
`./test.sh` specifically — the same "generalize, don't special-case" discipline every purpose-detection
phase in this project (`ACTION_INPUT_MODELING_01`, `TAP_PARSING_01`) has already held to.

### 3. Canonical-environment parity

Audit the intended contract between `docker.io/cloudflare/sandbox:0.12.5` and GitHub's real
`ubuntu-latest` runners. The missing `time` utility is small technically but conceptually important: if
DiffCI claims to reproduce CI, environment differences from the real runner need to be deliberate and
documented, not accidental. Scope: enumerate what GitHub's `ubuntu-latest` image actually ships
(`actions/runner-images`' own manifest is the authoritative source) versus what the canonical container
provides, and decide case by case what's worth adding versus documenting as an intentional, narrower
environment.

### 4. Output parser coverage — last, and possibly not needed at all yet

QUnit (lodash), `node-tap`'s CLI reporter (rimraf), and now AVA (chalk) each produced a `tests`/`failures`
count the harness's evidence parser didn't extract. **Do not conflate this with the ability to execute
CI**: lodash and chalk both reached the end of their reference arms with clean exit codes despite the
count not being extracted — the count gap never blocked either of their actual `REFUSED` outcomes (those
came from the inference arm, for unrelated reasons). Parser expansion is real, recorded, lowest-priority
work — getting the inference arm onto the executable path (items 1–2) matters more than counting tests on
a path that's already refused for other reasons.

## Methodology for validating any fix — the part that protects the evidence

**A fix is not validated by rerunning only rimraf/lodash/husky/chalk and calling it done.** That would
let the fix be shaped by the exact four cases it's tested against — the same contamination risk this
whole external-pilot exercise exists to avoid.

1. Fix, scoped and frozen as its own narrow plan per item above, implemented against synthetic/unit
   coverage first, same as every other engine-repair phase this project has run.
2. **Regression**: the existing five-repo `CI_REPRODUCTION_05` corpus (eslint/jest/webpack/babel/babel-loader)
   plus this four-repo external-pilot corpus (rimraf/lodash/husky/chalk) become **regression fixtures** —
   confirm the fix changes exactly what it should (e.g., chalk's `REFUSED` reason changing, or resolving)
   and nothing else (byte-identical elsewhere, the same discipline `GROUND_TRUTH_CONSISTENCY_01` held to).
3. **Fresh holdout**: only after regression passes, resume the mechanical ranking (`CI_REPRODUCTION_05`'s
   frame) at the next untouched rank — never re-examine or re-select from the four already screened here.
   This new set is a genuine holdout: nothing about it was seen, and no candidate in it influenced the
   fix.
4. Report the holdout's reproduction rate against the pre-fix baseline above, honestly, whatever it is.

**The milestone this is building toward:**

```
pre-fix unbiased corpus (frozen, this document)
  → measured failure taxonomy (this document's four-item queue)
    → bounded engine changes, one item at a time, each frozen before code
      → old-corpus regression (five-repo + four-repo, byte-identical where unrelated)
        → untouched post-fix external holdout (fresh mechanical selection, never seen before)
          → reproduction rate, reported honestly
```

This is deliberately harder to dismiss as benchmark engineering than continuing candidates until one
happens to say `REPRODUCED`: the pre-fix baseline is already public record, the fixes are scoped and
frozen before the holdout exists, and the holdout is selected by the same bias-free mechanical process
this whole pilot has used throughout.

## What this plan does not do

It does not implement anything yet. It does not pick which of items 1–4 gets a narrower plan written
next beyond stating the priority order — that narrower plan, and confirmation to start writing engine
code, comes after this freeze.
