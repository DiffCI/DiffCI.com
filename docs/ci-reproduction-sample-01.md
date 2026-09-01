# FROZEN — CI_REPRODUCTION_SAMPLE_01

**Committed before any workflow belonging to jest, webpack, babel or babel-loader was read, and before
any inference result for them exists.** The five identities were already known from screening, which is
unavoidable; nothing beyond those identities has been inspected at the time this is written.

This amends `docs/ci-reproduction-05-eligibility.md`, which said "first qualifier in rank order" and did
not say what happens when that qualifier **refuses**. Advancing to the next candidate on a refusal would
be target-shopping — running repositories until DiffCI succeeds — and that is the exact tautology the
eligibility protocol exists to prevent. The repair is to commit to the whole sample in advance so a
refusal is a data point instead of a discard.

## The sample — fixed, complete, no substitutions

The five R1/R2/R4 qualifiers in their frozen rank order:

| # | rank | repository |
|---|---|---|
| 1 | 2 | `eslint/eslint` |
| 2 | 6 | `jestjs/jest` |
| 3 | 8 | `webpack/webpack` |
| 4 | 10 | `babel/babel` |
| 5 | 11 | `babel/babel-loader` |

**No stopping on the first `REPRODUCED`. No replacing a repository that refuses. Every outcome stays in
the denominator.** A sample that drops its inconvenient members is not a sample.

## The sequence, identical for every repository

```
R3 reference-only qualification      engine NOT invoked
  ↓ (only if R3 qualifies)
first-exposure inference             engine sees the repository for the first time
  ↓
TEST plan
  ↓
execute ONLY if the plan is executable
  ↓
compare against real-CI ground truth
```

Unchanged from `CI_REPRODUCTION_05`. The reference-only stage exists so a repository's eligibility can
never depend on whether the engine copes with it.

### eslint is carried forward, not re-run

`eslint/eslint` already went through exactly this sequence and produced `REFUSED`
(`docs/ci-reproduction-05-result.md`). Re-running it would destroy the one property that cannot be
recovered — first exposure — and would change nothing else. It is sample member 1 with its result as
recorded.

## Outcome vocabulary

| outcome | meaning |
|---|---|
| `REPRODUCED` | plan executed; result materially equivalent to the reference arm **and** consistent with CI ground truth |
| `CORRECT_REFUSAL` | engine refused, and the cited missing requirement is **verifiably absent** in the repository |
| `INCORRECT_REFUSAL` | engine refused, but the cited requirement is **actually present** — the engine failed to see it |
| `DIVERGED` | plan claimed executable; execution shows the graph wrong or incomplete |
| `ENVIRONMENT_INADEQUATE` | R3 failed, or environment signals dominate the suite result |
| `UNVERIFIABLE` | arms agree but no usable CI ground truth exists for the cell |

### Correct vs incorrect refusal, decided mechanically

This has to be fixed **now**, or I would be grading my own engine's refusals after seeing them.

A refusal is `CORRECT_REFUSAL` **iff** the requirement it names is verifiably absent at the pinned head:

| cited requirement | verification |
|---|---|
| pinned dependency basis | no committed lockfile (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `npm-shrinkwrap.json`) **and** no `packageManager` field |
| local action / composite action | the referenced path does not exist at the pinned head |
| reusable workflow | the referenced workflow file does not exist |
| service container | the job declares a `services:` block the engine cannot instantiate |
| script reference | the referenced script is absent from `package.json` scripts or the filesystem |

If the cited requirement **is** present, the outcome is `INCORRECT_REFUSAL` — a defect against DiffCI,
recorded as such. If a refusal cites something this table cannot check, it is `INCORRECT_REFUSAL` by
default: an unfalsifiable refusal is not a correct one.

**Every refusal preserves its reason verbatim**, including the blocking node id and the missing
requirement, so the distribution can be read by cause and not merely by count.

## Reading the distribution

Five `CORRECT_REFUSAL`s would **not** mean reproduction succeeded. It would mean epistemic safety is
working and **addressability is the product bottleneck**. Those are different findings and the report
must not blur them.

## Terminal decision rule — fixed in advance

This is the **last reproduction sample before the roadmap turns to optimisation.**

- **≥ 1 genuine `REPRODUCED`** → those repositories become the initial substrates for
  `CI_OPTIMIZATION_01`.
- **0 `REPRODUCED`, all refusals correct** → **do not start another external sample.** That is itself
  the product result: *DiffCI's immediate bottleneck is faithful CI addressability, not optimisation.*
  Then improve the single dominant refusal capability as product engineering, keeping these five as the
  evaluation set.
- **Any `INCORRECT_REFUSAL` or `DIVERGED`** → an engine defect, fixed before any optimisation claim.

## What is fixed before execution

- Zero human command repair. A reference arm needing a command the workflow does not state is a
  qualification failure, not something to hand-write.
- Every repository's R3 and inference receipts are preserved, including failures.
- Reference plans are hand-transcribed from each workflow **after** this freeze, as R3 requires; that
  transcription is the only workflow inspection permitted before a repository's inference runs.
- Attempts 1–4 against `html-webpack-plugin` stay preserved as recorded, including attempt 2's protocol
  violation, attempt 3's incorrect `DIVERGED` and attempt 4's incorrect `REPRODUCED`.

## Why this sampling rule exists at all

`html-webpack-plugin` taught it. Arm-to-arm agreement was insufficient; the environment could not run
that suite; and real CI had cancelled every test cell, so no completed ground truth existed to reproduce.
A protocol that could return `REPRODUCED` under those conditions was measuring the wrong thing.

And the eslint result is the behaviour to protect, not to explain away: **38627 tests passing in the
reference arm while DiffCI executed zero inferred operations, because it could not justify the install
environment.** That is what we want before DiffCI is given authority over anyone's CI.
