# Step 5.2 — the eligible population is EMPTY. The draw cannot proceed.

Computed from records, persisted at `docs/evidence/generation-c-population.json`. No repository was
inspected in search of an attractive result; the criteria below were applied to a frame that was frozen
on 2026-08-30, before generation C existed and before the Candidate-5 thesis was formulated.

## The frame

`npm-high-impact@1.13.0`, export `topDependent`, published **2026-06-08** — an external ordering by a
third party, recorded "BEFORE any repository configuration was inspected". Ranks 1–40, 4687 entries in
the source overall.

## The criteria, all pre-existing

| | criterion | why it is independent of the hoped-for result |
|---|---|---|
| **E1** | ADDRESSABLE — reached qualification in the frozen addressability survey | Defined and run 2026-08-30, before this experiment was conceived |
| **E2** | GREEN — suite qualifies green in the canonical environment | Without a green baseline no mutation can be attributed to anything |
| **E3** | UNMEASURED — no DiffCI observation, selection or economics rows exist | A specimen whose measurement has been seen is not a blind draw |

None of these selects for mapping density, test cost, selection size, or anything else that correlates
with DiffCI winning.

## The arithmetic

```
frame ranks 1-40                                          40
  excluded E1  not addressable                            -34   (17 monorepo scope, 11 runner
                                                                  unsupported, 3 already examined,
                                                                  2 not JS/TS, 1 archived)
  excluded E2  webpack/webpack, qualification RED           -1
  excluded E3  already measured by DiffCI                   -5   prettier, eslint-config-prettier,
                                                                  ts-jest, css-loader, cross-env
                                                        ------
ELIGIBLE                                                     0
```

**The frozen 40-repository frame is exhausted.** Every repository in it that DiffCI can actually mutate
has already been measured. Only 6 of 40 ever reached qualification; one was red; the other five are the
five this project has spent the last week measuring.

## Why I am not resolving this myself

Three ways out exist, and they are not equivalent. Each changes what the experiment's independence claim
is worth, which is the whole point of Step 5.

**A — extend the frame down the same external ordering** (ranks 41–100 of `npm-high-impact@1.13.0`).
Preserves independence exactly: the order is fixed by a third party and predates everything. Costs an
addressability survey run over ~60 repositories under generation C, and at the observed ~15% yield would
produce roughly 5–9 eligible candidates. This is the option I would choose.

**B — drop E3 and draw from the five already measured.** Cheap and immediate, but the draw is no longer
blind: their behaviour under generation B is known, ts-jest's in detail. Any result would carry a caveat
that cannot be removed afterwards.

**C — change the frame source.** Fastest to make yield, and the weakest: choosing a new population after
learning the old one is exhausted is exactly where an unexamined preference enters.

I am not choosing between these unilaterally. **A costs container hours that are wasted if you want a
different population; B and C weaken the independence claim in ways only you should accept.** The
population definition is the load-bearing part of Step 5, not an implementation detail.

## What is done regardless

- **5.1 is complete.** The apparatus identity is frozen at `docs/evidence/apparatus-gen-c/APPARATUS_IDENTITY.json`
  and enforced at runtime: a job declaring `requiresApparatus: "gen-c"` FAILS if the container's agent
  digest, image or node version differs, with generation B named explicitly as the defect-18 failure
  mode. Tests pin the file and the code to the same values so the two copies cannot drift.
- **5.2 is complete as far as it can be**: the full population, every exclusion and its reason, is
  persisted rather than summarised.
- **Steps 5.3–5.6 are blocked** and nothing has been drawn.

## Boundary held

Zero DiffCI observations of any sealed experiment. Zero mutations. Nothing drawn.
