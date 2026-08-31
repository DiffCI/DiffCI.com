# FROZEN — the generation-C repository draw rule

**Written and committed BEFORE the randomness exists.** That is the whole design: the seed is derived
from the hash of *this document's own commit*, a value that cannot be known while the document is being
written and that I cannot choose.

## The input population, frozen first

Exactly the five repositories in `docs/evidence/generation-c-eligible-population.json`, frozen at
`0f6ea3f` before this rule was written.

## Canonical ordering

**Ascending frame rank.** Not alphabetical, not by test count, not by anything measured about the
repository. Rank is the third-party ordering the population was drawn from, fixed by
`npm-high-impact@1.13.0` and published 2026-06-08.

```
index 0 → rank  62   eslint-community/eslint-plugin-promise
index 1 → rank  75   webpack/postcss-loader
index 2 → rank 112   ezolenko/rollup-plugin-typescript2
index 3 → rank 115   webpack-contrib/extract-text-webpack-plugin
index 4 → rank 153   jest-community/eslint-plugin-jest
```

## Randomness source

```
H    = the full 40-hex commit hash of the commit that adds THIS FILE
seed = sha256(H)                       -- H as its lowercase hex string, UTF-8, no trailing newline
index = uint32(first 8 hex chars of seed) mod 5
```

**Why this source.** A seed I pick is a seed I could have chosen for its outcome. A seed derived from a
commit hash cannot be: `H` depends on the tree, the parent, the author, the timestamp and the message,
and is not computable in advance. The rule is fixed before `H` exists, and once `H` exists the result is
fully determined — so anyone can recompute it and get the same repository.

Verification, by anyone, from the public repository:

```bash
H=$(git rev-parse <this commit>)
printf '%s' "$H" | sha256sum
```

Take the first 8 hex characters of that digest, read them as a uint32, take mod 5, and index the table
above.

## The draw is made ONCE

**No redraw for any reason.** Explicitly not for: repository size, test count, suite duration, mapping
density, likely savings, monorepo shape, perceived suitability, or a feeling that another of the five
would make a better experiment.

If the drawn repository turns out to be awkward, that is a result about the population, not grounds for
a second draw. A draw that can be repeated until it pleases is not a draw.

## Immediately after the draw

The draw artefact records `H`, the seed, the arithmetic, the ordering, the index and the selected
repository, and is checksummed at once — before anything is done with the result.

## What happens next, and what does not

The candidate universe is then constructed **for the drawn repository only**, mechanically, under the
generation-C rules. The other four are not touched.

**`observe` and `mutate` are NOT run.** Step 5 ends with a sealed repository, candidate universe,
target, apparatus identity, protocol and stop rule, and **zero DiffCI observations** of any of it.
