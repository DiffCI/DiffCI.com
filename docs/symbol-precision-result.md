# Symbol precision diagnostic: result

Pre-registered at `docs/symbol-precision-preregistration.md`. Artifact
`docs/evidence/vue-symbol-precision-diagnostic.json`, sha256
`9f49312d73ea33742715e68f95caebed86a206558d45d33d8f48b14a619e2056`.

Commit `ef82a2677`, changed file `packages/shared/src/looseEqual.ts`, symbols `looseEqual` and
`looseIndexOf`, against the frozen 183-file selection.

## Result

```
DEMONSTRATED    99   a consumer in the closure references looseEqual/looseIndexOf
ABSENT          19   no reference, and nothing defeated the analysis
UNRESOLVED      65   the analysis could not resolve the closure
------------------
sum            183   (selection 183)
```

**File opportunity upper bound = 19.** `ABSENT` only.

Not `183 − 99 = 84`. That figure would silently convert every unresolved case into opportunity, which
is the single easiest way to overstate this result and is forbidden by the pre-registration.

**No CPU opportunity is reported.** Per-file execution cost was not measured, and manufacturing it from
file counts is forbidden. File opportunity and CPU opportunity are different quantities and only the
first was measured.

## Against the pre-registered thresholds

`D + U = 164` of 183, which falls in the first band fixed in advance:

> ~160+ remain DEMONSTRATED or UNRESOLVED → symbol precision probably cannot rescue Vue's economics.
> Topology, not granularity, is the binding constraint. That strengthens the eligibility-gate direction
> over the build-it direction.

## Why, and it is not the barrel's fault

The barrel is not the whole story. `looseEqual` is genuinely consumed by a small number of files, and
one of them sits at the heart of the runtime:

```
 13  packages/runtime-dom/src/directives/vModel.ts
  5  packages/server-renderer/src/helpers/ssrVModelHelpers.ts
  4  packages/runtime-core/src/compat/instance.ts
  2  packages/runtime-core/src/componentRenderUtils.ts     <- central to Vue's runtime
 93  packages/shared/__tests__/looseEqual.spec.ts
```

`componentRenderUtils.ts` really does call `looseEqual`, and nearly every runtime test depends on
`componentRenderUtils.ts`. So even perfect symbol-level resolution through the barrel would still select
most of the closure: **the dependency survives at symbol level, not only at file level.**

That is a more interesting answer than "the barrel over-selects". The barrel explains why the buckets
are identical and why the closure is *reached*; it does not explain the closure away.

## A defect found and fixed mid-experiment

The first run returned `DEMONSTRATED 183 / ABSENT 0 / UNRESOLVED 0` — an absolute result that was a
**tautology, not a finding**. The changed file is in every closure by construction, since being
reachable from it is exactly why those tests were selected, and it defines the symbols it exports. A
barrel re-exporting it contains the identifier textually for the same non-reason.

The diagnostic now skips the definition site and strips `export … from` lines before scanning, so only
genuine consumers count. Recorded rather than quietly corrected: the first result would have "confirmed"
that symbol precision offers nothing, by construction rather than by evidence.

## How conservative `UNRESOLVED = 65` is

A test is marked UNRESOLVED if **any** file anywhere in its closure contains a construct this analysis
cannot follow — a star import, an aliased re-export, a `require`, or a dynamic import. Vue's closures
run to hundreds of files, so a single unresolvable construct condemns the whole test.

`U` is therefore almost certainly inflated, and a sharper analysis would move some of it into `ABSENT`.
The pre-registration forbids claiming that, and the number is left where it landed. It is recorded here
so a later reader knows the bound is loose in the conservative direction, not the flattering one.

## What this does and does not establish

**Establishes:** under this diagnostic, at this commit, on this repository, at most 19 of 183 selected
files show evidence of symbol-level irrelevance.

**Does not establish:** that a production symbol-aware selector could safely deselect those 19, that it
would preserve the recall property, or that this generalises beyond one commit and one symbol. Those
remain three separate evidentiary steps:

1. **Diagnostic opportunity** — does symbol information identify safely excludable-looking work? *This
   experiment. Answer: very little, here.*
2. **Selector realisation** — could an actual selector exploit it while remaining fail-closed? *Not
   attempted.*
3. **Safety and generalisation** — would that changed selector retain recall across mutations and
   repositories? *Not attempted; recall evidence would need re-establishing for any changed selector.*

## Consequence

The strongest available case for symbol precision has been tested and it did not survive. `looseEqual`
was chosen precisely because it was the most extreme barrel-mediated selection in the corpus — 183 of
196 files from a single utility. If symbol precision cannot recover meaningful work there, it is
unlikely to rescue Vue elsewhere.

This shifts weight toward the **eligibility-gate direction**: predicting before deployment whether a
repository's topology makes DiffCI economically useful, rather than trying to make DiffCI useful on
repositories where the dependency structure genuinely requires the tests it selects.

The existing selector and the frozen Vue economics are unchanged.
