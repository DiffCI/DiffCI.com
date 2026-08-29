# Safety-validation phase: closed (2026-08-29)

All evidence below was produced in the canonical Linux environment
(`docker.io/cloudflare/sandbox:0.12.5`, node v22.23.2, Ubuntu 22.04.5), by the packaged agent
`sha512-mj4GQJ…7Kw==`, against pinned commits, and frozen with verified checksums before interpretation.

## The claim, stated exactly

> **25 canonical recall-measurable cases across hono and zod. 25 confirmed. 0 observed false greens.**

Not "100% safe". Not a false-green *rate* — 25 cases cannot support a reliability estimate, and the
frozen zod bundle prints that caveat itself.

## The corpus

| Repository | Safety | Selection vs comparator |
|---|---|---|
| `honojs/hono` | 20/20 canonical measurable confirmed; 13/13 reproduced from developer host | poor — 12/20 `SELECTION_OVERBROAD` |
| `colinhacks/zod` | 5/5 measurable confirmed; first qualified monorepo | positive — 4/5 `EFFICIENT`, 1 overbroad |
| `TanStack/query` | not measurable | not measurable |
| `unjs/h3` | earlier developer-host evidence | some positive indication |

## What zod established

hono showed safety can hold while DiffCI loses economically to a trivial comparator. **zod shows that
losing to the comparator is not inevitable.**

Across the five confirmed zod cases: **629 tests selected, 761 by the path-rule comparator, 967 for
FULL.**

The defensible wording, and the only one to be used:

> On five recall-measurable zod mutations, DiffCI executed **17% fewer tests** than the path-rule
> comparator while preserving mutation detection. **Whether this translates into incremental compute
> savings has not yet been measured.**

"Fewer tests" is not "savings". That gap is the entire next experiment.

## An open observation, deliberately not fixed

zod's selection is nearly constant — 125 to 127 tests — while the comparator swings from 113 to 193.

```
commit     FULL  comparator  DiffCI  detecting  verdict
fb3af01f7   194     134        127      1315    EFFICIENT
773a48676   193     132        126       202    EFFICIENT
68fb3f138   193     193        125       130    EFFICIENT
37b015017   193     189        125        15    EFFICIENT
212b94179   194     113        126         4    SELECTION_OVERBROAD
```

Two competing explanations, and this evidence does not separate them:

- **Benign:** DiffCI identifies a stable affected region of the monorepo containing ~125 tests, and the
  comparator needlessly expands on four of five commits.
- **Adverse:** DiffCI has settled on a coarse ~125-test bucket and is not discriminating much per
  commit. On `212b94179` — where the path rule was tight at 113 — DiffCI ran 126 to catch a mutation
  that 4 tests detect.

**Neither changes the next decision**, because even a coarse bucket is commercially useful if running it
plus DiffCI's analysis costs materially less than the comparator. So this is preserved as an
observation rather than optimised away before measurement. The compute data may show it is irrelevant,
or may show exactly why it matters.

## Mutation generation, not selector safety, was the binding constraint on zod

6 of 11 zod candidates came back `RECALL_UNMEASURABLE`, all for the same honest reason: *"none of this
merge's revertible source files produced a full-suite failure, so its own tests do not cover them."*
The denominator was 5 because that is what the methodology produced, not because a larger one was
sought.

## Why this corpus is stronger for not being uniformly positive

The laboratory has demonstrated it can return **confirmed, unmeasurable, dirty, invalid, timeout,
contradictory-execution-evidence, and not-qualified** rather than funnelling everything toward success:

- `TanStack/query` — refused, because authoritative nx execution was non-green.
- `tanstack-qualify-02` — permanently **INVALID VERDICT**: the harness ignored process exit status and
  produced a false green. Preserved as a defect, not rewritten as "superseded".
- `zod-qualify-01` — refused after a three-hour infrastructure timeout rather than manufacturing a
  verdict. Cause never established, and none claimed.

Four defects in the validation machinery were found and fixed during this phase, each capable of
producing evidence stronger than reality warranted: ANSI output defeating result interpretation, an
ignored exit status, an unbounded clone stage, and two divergent process environments inside the
mutation harness.

## What happens next

Compute measurement. For each selected candidate, under equivalent runner conditions:

    C_full, C_comparator, C_diffci_selected, C_diffci_analysis

    Gross       = C_full       - (C_diffci_selected + C_diffci_analysis)
    Incremental = C_comparator - (C_diffci_selected + C_diffci_analysis)

**Incremental is the business case.** Measured as actual resource consumption, not wall time — a
20-second test can consume more compute than a 30-second one depending on parallelism and runner
utilisation.

The test-count evidence predicts hono weak-or-negative and zod potentially positive. If compute
measurement reproduces that distinction, it establishes something more valuable than another repository
where DiffCI looks good: that **DiffCI's value depends on whether its intelligence beats the cheapest
credible alternative after paying for itself.**

No fifth repository. No selector optimisation.
