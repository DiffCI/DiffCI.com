# FROZEN — frame continuation rule, generation C

**Written and committed BEFORE any repository at rank ≥ 41 was resolved, named or inspected.** That
ordering is the substance of this document, not a formality: a continuation rule written after seeing
what lies at rank 41 is not a rule, it is a selection.

## Why a continuation exists at all

The original frame — `npm-high-impact@1.13.0` export `topDependent`, ranks 1–40, published 2026-06-08,
resolved 2026-08-30 — was **exhausted mechanically**, not abandoned:

```
40 entries → 6 reached qualification → 1 red + 5 already measured → 0 eligible
```

Recorded at `docs/generation-c-population-exhaustion.md` and `docs/evidence/generation-c-population.json`,
both committed at `a65cbfb` **before** this continuation was authorised. That artefact is preserved
exactly as it stands and is NOT rewritten to look as though ranks 1–100 were always the population. The
chronology is part of the provenance.

The expansion happened because the frame ran out, and for no other reason. No repository at rank ≥ 41
had been looked at when this was decided.

## The rule

```
Traverse npm-high-impact@1.13.0, export topDependent, in SOURCE ORDER, beginning at rank 41.
Apply the frozen generation-C eligibility rules E1, E2, E3 without modification.
Stop when N = 5 eligible, previously unmeasured repositories have been obtained,
or when the external frame (4687 entries) is exhausted.
```

**N = 5.** Chosen now, before any rank ≥ 41 is known. Five gives the downstream draw real entropy while
keeping the qualification cost bounded. Ten would be a stronger population and considerably more
qualification work; the trade was made here rather than after seeing the yield.

- **No rank is skipped.** Traversal is sequential. A repository that fails E1, E2 or E3 is recorded with
  its reason and the traversal continues to the next rank.
- **No rank is examined out of order** to see whether it looks promising.
- **The stopping point is the count, not a rank ceiling.** "Survey 41–100 and hope" would leave the
  population size hostage to yield; at the observed ~15% it might have produced one eligible repository,
  which is a mechanical draw with no randomisation in it.
- **E1, E2, E3 are unchanged.** Not relaxed, not tightened, not supplemented.

## The eligibility rules, restated unchanged

| | criterion |
|---|---|
| **E1** | ADDRESSABLE — reaches qualification under the frozen addressability survey definition |
| **E2** | GREEN — its own suite qualifies green in the canonical environment |
| **E3** | UNMEASURED — no DiffCI observation, selection or economics rows exist for it |

## What eligibility screening may and may not learn

Screening is permitted to learn **only** what E1, E2 and E3 require.

**Permitted:** resolve the repository; read its package manifest and runner configuration; run its
documented install, build and baseline suite (E2 cannot be answered otherwise); check this project's
records for pre-existing rows (E3).

**FORBIDDEN during screening:**

- running DiffCI `observe` or `mutate` on it;
- computing or reading its mapping density, import density, or graph statistics;
- inspecting its commit history for changes that look favourable;
- recording or looking at any selection size, selection content, or economics.

The reason is the property generation C exists to protect: **repository choice must be independent of
observed DiffCI behaviour.** Learning during screening that a repository is favourable would destroy it
just as surely as picking one on purpose.

Note this excludes the mapping-density survey, which WAS run over ranks 1–40. It is not part of E1/E2/E3
and must not be run here.

## Sequence, and where it stops

```
external ordering → mechanical eligibility → 5 eligible repos → freeze population →
reproducible random draw → candidate construction → mechanical target selection → SEAL → STOP
```

Only step 6 asks DiffCI what it thinks. Nothing before the seal observes or mutates anything.

## Exclusions are persisted, not summarised

Every rank traversed is recorded with its outcome and reason, in the same shape as ranks 1–40, so
another person can reproduce exactly why each repository was or was not eligible.
