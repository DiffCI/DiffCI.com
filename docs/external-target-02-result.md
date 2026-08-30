# External validation target #2: `date-fns/date-fns` — `NOT_ADDRESSABLE`

**Outcome: `NOT_ADDRESSABLE` by the current apparatus.** No `datefns-qualify-02` was run, because the
path-semantics prerequisite was not met. No observation, no prediction, no economics.

## `datefns-qualify-01` — INVALID VERDICT, permanently

> **`datefns-qualify-01`: INVALID VERDICT** — qualification exercised only 14/269 repository test files
> and omitted the 255-file core test surface.

The broken harness emitted `MUTATION-QUALIFIED`. That string describes what the harness printed and is
never the status of this run.

**Reproduced independently.** The bare root invocation was re-run on a Windows developer host against
the same pinned commit and collected **the same 14 test files**. The defect is in the command choice,
not in the container.

### A correction to the numbers I first reported

I wrote "14 of 269". That figure was wrong — it added core's 255 on-disk `test.ts` files to the 14 that
ran, which mixes two different populations. Measured directly:

| population | count |
|---|---:|
| Test files the bare root invocation collected | **14** |
| Files `pkgs/core` collects under its own config | **262** (253 `[main]` + 9 `[temporarily]`) |
| `test.ts` files on disk under `pkgs/core` | 255 (2 lie outside `src/`, excluded by `dir: "src"`) |
| Test-shaped files on disk outside `pkgs/core` | 19 |

The finding is unchanged and if anything larger: **core contributed nothing, and it is 262 files.**

## The three invariants

Tested locally against the pinned commit — apparatus calibration, no DiffCI observation.

### 1. FULL — ✔, but only with `cwd = pkgs/core`

```
cwd=pkgs/core   node node_modules/vitest/vitest.mjs run
  Test Files  262 collected      Tests  3279
```

No invocation from the clone root reaches it. Every alternative was tried and each fails for a distinct
reason:

| invocation (cwd = clone root) | result |
|---|---|
| `run` | **14 files** — the defect |
| `run --root pkgs/core` | `No test files found` — the root config still loads, and `projects: ["pkgs/*"]` resolves to `pkgs/core/pkgs/*` |
| `run --config pkgs/core/vitest.config.ts` | `No test files found` — `dir: "src"` resolves against cwd, i.e. `<root>/src`, which does not exist |
| `run --root pkgs/core --config pkgs/core/vitest.config.ts` | config load error: `--config` is resolved *relative to* `--root`, giving `pkgs/core/pkgs/core/vitest.config.ts` |

The harness runs the test module with `cwd = repoPath` in both `dogfood-qualify.ts` and
`dogfood-mutate.ts`. It has no concept of a test working directory.

### 2. SELECTED — ✔ with core-relative paths, and **silently empty** with repo-relative ones

```
cwd=pkgs/core, filter "src/addDays/test.ts"            ->  1 file: src/addDays/test.ts
cwd=pkgs/core, filter "pkgs/core/src/addDays/test.ts"  ->  0 files
```

Vitest's positional argument is a filter that a file path must *contain*. A repo-relative path is longer
than the path it names, so it matches nothing. Exactly one file matched the correct form — no
over-selection from `test.tp.ts` siblings.

### 3. PATH NORMALIZATION — ✘, and this is what closes the target

A mechanical, arm-agnostic transformation exists for selections *inside* `pkgs/core`: strip the
`pkgs/core/` prefix. It fails for everything else.

**DiffCI's test universe is computed by `src/repo/analyzer.ts` at the clone root, so it spans the whole
monorepo.** Under a `pkgs/core` scope, any selected file in `tz`, `utc` or `docs` would have to be
*dropped*.

Dropping a selected file is **not path normalization — it is editing the decision under measurement**,
and it would be applied to whichever arm happened to select outside core. That is precisely the
arm-specific treatment invariant 3 forbids.

## Why this is `NOT_ADDRESSABLE` rather than a fix

Making date-fns measurable needs two things, and the second is disqualifying:

1. **A test working directory in the harness.** A real new capability, but a general one — any monorepo
   whose packages test independently needs it. Not a date-fns hack.
2. **DiffCI's universe scoped to that subdirectory.** This is not plumbing. It changes what the product
   analyses, so that its decision and its measurement describe the same universe.

The second is a product change proposed while a repository is under external assessment, to make that
repository assessable. Whatever its independent merits, building it now is the thing the protocol
exists to prevent.

**Recorded, not concealed:** it is genuinely unknown whether scoping would have favoured DiffCI on
date-fns. No selection ratio, comparator count, or analysis CPU was ever produced for this repository.
The target closes with **zero information about its sign**, which is the only state in which closing it
is honest.

## What this says about the product, which is the useful part

Two external targets, two refusals, two different causes:

| | |
|---|---|
| `fastify/fastify` | `NOT_QUALIFIED` — suite not green in the canonical environment |
| `date-fns/date-fns` | `NOT_ADDRESSABLE` — monorepo whose real test surface is only reachable from a subdirectory |

Neither is a failure of the eligibility *rule*, which never ran. Both are **coverage limits of the
assessment apparatus**, and they are now measured rather than assumed:

> The assessment currently requires a repository whose full test suite is green in a Linux container
> and runnable from the repository root.

That is a materially narrower market than "any repository with CI", and it is the honest description.
It also names the highest-value apparatus investment — per-package execution scope for monorepos — with
evidence rather than speculation. **That investment is not started, and must not be started against a
named target.**

## Status

`date-fns/date-fns` — **`NOT_ADDRESSABLE`**. Permanent. Target #3 is the user's to name.
