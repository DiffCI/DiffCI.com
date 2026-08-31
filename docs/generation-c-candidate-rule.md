# FROZEN — generation-C candidate universe construction

**Written before the filter was run on the drawn repository.**

Drawn repository: `jest-community/eslint-plugin-jest` @ `c7bf004e00271f88bc8dd2b6a0e378dfc33f02da`
(sealed draw `209c56b`, index 4 of 5).

## The filter is not new

`scripts/select-source-candidate.ts`, unchanged, the same mechanical rule used for MECHANISM_PROOF_01
including amendment A1. Transcribed:

- modifies at least one ordinary implementation source file (any `src/` directory)
- does **not** modify `package.json`, lockfiles, `tsconfig*`, runner/tooling configs, `.github/`, dotfiles
- is not dependency automation
- is not test-only
- small: 1–5 implementation files changed
- **A1**: at least one implementation file inside the comparator's execution scope

**First matches in history order win.** No commit is chosen for looking promising, and none is skipped
for looking unpromising.

## Parameters for this repository, and how they were determined

```
--repo           <clone at c7bf004e>
--count          5          (same as MECHANISM_PROOF_01: one mutant is fragile, not a mechanism)
--limit          400        (default, unchanged)
--exclude-scope  ""         (empty — see below)
```

### Why `--exclude-scope` is empty

A1 exists because ts-jest keeps `e2e/`, `examples/`, `presets/`, `scripts/` and `website/` outside what
its jest run executes, so an implementation change confined to those directories could never be
detected by the suite.

This repository has no such region. From its own `jest.config.ts` at the pinned tree:

- the **`test`** project declares no `testMatch`, so jest's defaults apply, with
  `testPathIgnorePatterns` excluding only `lib/`, `src/rules/__tests__/fixtures/*` and
  `src/rules/__tests__/test-utils.ts`;
- the **`lint`** project (`jest-runner-eslint`) declares `testMatch: ['<rootDir>/**/*.{js,ts}']` —
  literally the whole repository.

Implementation lives under `src/`, tests are co-located in `src/rules/__tests__/`, and the top level
holds only `docs/` (markdown) and root config files, which the filter already rejects as global-risk or
non-implementation.

So the comparator's execution scope is the whole repository, and A1's constraint is satisfied by every
implementation file rather than restricting anything. **Empty is the correct value here, not a
loosening**: inventing exclusions would narrow the candidate universe on no evidence.

## A property of this repository worth recording before results exist

Its jest configuration uses **`projects`** — the multi-project orchestration that this project's
`CONTRADICTORY_EXECUTION_EVIDENCE` guard was written to detect, and the reason `jest-dom` was refused.
Here the suite qualified GREEN twice, exit 0, 240 suites and 4809 tests, so the guard did not fire.

It is recorded now, before any candidate is observed, because it is exactly the kind of structural fact
that would look like a post-hoc explanation if it were mentioned only after an awkward result.

## What is produced, and what is not

Every commit examined is recorded with its inclusion or exclusion reason — the whole traversal, not just
the five that match. Nothing is re-drawn or substituted.

**`observe` and `mutate` are NOT run.** This step reads git history and file paths only. No DiffCI
analysis touches the repository.
