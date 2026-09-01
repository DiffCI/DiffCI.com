# FROZEN — generation-C target selection rule

**Committed before the index was calculated.** I have not read the input checksum value at the time of
writing this file.

## The rule

```
C     = sha256 of docs/evidence/generation-c-candidate-pairs.json,
        as recorded in docs/evidence/generation-c-candidates-CHECKSUMS.json  (sealed at d151f76)
seed  = sha256(C)          -- C as its lowercase hex string, UTF-8, no trailing newline
index = uint32(first 8 hex chars of seed) mod 5      -- 0-based, into the frozen candidate order
```

The candidate order is the one already sealed in `generation-c-candidate-pairs.json`, which is history
order under the unchanged filter — not reordered for this step:

```
index 0 → candidate 1   58e487fec   fix(prefer-to-have-been-called): don't crash on matcher without an argument
index 1 → candidate 2   3629019d8   fix(prefer-to-have-length): don't crash on expect chain without a value
index 2 → candidate 3   197f34167   refactor(valid-expect): use optional chaining
index 3 → candidate 4   d848f70d5   fix(no-export): handle literal property accessors
index 4 → candidate 5   fc5657c88   refactor: use replaceText in fixers when possible
```

## What the rule depends on, and what it must not

It depends only on **the checksum of the already-sealed candidate universe** — a property fixed at
`d151f76`, before this rule existed.

It does **not** depend on, and must never depend on: DiffCI's decision or mode, selected-test count,
selection content, expected or measured savings, mapping density, graph statistics, suite duration,
number of implementation files changed, whether the candidate edits a test file, or mutation outcome.

All five candidates therefore get equal mechanical treatment — including candidates **3 and 5**, which
change no test file and are for that reason the most informative, without being deliberately favoured.
Choosing them on purpose would be selecting the experiment for its expected interest.

## An honesty note on the strength of this guarantee

The repository draw derived its seed from a commit hash that **did not exist** when the rule was
written, so the outcome was unknowable in principle.

This rule is weaker: `C` already existed when the rule was written. The guarantee rests on two things a
reader can check rather than take on trust —

1. **Commit order in git history.** This rule is committed before the commit that records the result.
2. `C` was produced by a checksumming pass whose values were never printed to me, and this document
   states that plainly.

The weaker guarantee is stated rather than glossed, because a reader deciding how much the sealing is
worth should be told which of the two kinds it is.

## One target, no redraw

The computed index selects **one** target candidate. No recomputation, no substitution, and no second
target for any reason — including the target turning out to be a refactor rather than a fix, selecting
nothing, selecting everything, or being awkward to mutate.

The other four candidates remain sealed in the universe artefact and are **not** discarded: they are
part of the record of what was available when the target was chosen.
