# FROZEN — TAP_PARSING_01

**Written before a single line of the repair**, per the same discipline the last three plans used.
Scoped from `docs/evidence/regression-02-full/results.md`'s babel-loader finding: `DIVERGED`, `"neither
arm executed a suite"`, even though both arms ran the identical command and both produced real,
substantive TAP output with individual subtest results.

## The exact parser path, traced before any design

The question this plan answers first, per direction: **why does the harness fail to derive a numeric
suite/test count from Node's native TAP output even though it successfully observes failures?**

Two entirely separate functions supply the two numbers, and only one of them has ever been taught Node's
native test runner's shape:

- **`failures` comes from `parseTestOutput()`** (`scripts/test-output-parsers.ts:122`), which already has
  a `node:test` adapter (`test-output-parsers.ts:61-72`): `/^[#ℹ] fail (\d+)\s*$/m`. This module's own
  docstring states its scope precisely: "the mutation classification turns entirely on one question - did
  this run detect the mutation" — it was built to answer *only* that question, for a different consumer
  (mutation-recall), and correctly never tries to derive a total count.
- **`tests`/`testFiles` come from `countsOf()`** (`scripts/ci-reproduction.ts:203-231`), a completely
  separate function, consumed only by `classify()` via `suiteOf()` (`ci-reproduction.ts:453`:
  `a.steps.find((s) => typeof s.tests === "number" && s.tests > 0)`). Read in full, `countsOf` has exactly
  two branches: a Jest-shaped one (`Tests:.*?(\d+) total`) and a Mocha-shaped one (`(\d+) passing` /
  `(\d+) failing` / `(\d+) pending`, added specifically because eslint's mocha output matched neither
  the Jest pattern nor anything else — its own comment names the exact same failure mode this plan is
  about: "a jest-shaped parser silently reporting nothing is indistinguishable from a graph that runs
  nothing... the same unknown-as-negative confusion as defects 23 and 25"). **There has never been a
  branch here for Node's native TAP output at all** — not a bug in an existing regex, an omission.

Confirmed against the frozen raw output (`docs/evidence/regression-02-full/babel-loader/reproduction.json`,
`referenceArm.steps` / `inferenceArm.steps`, the `yarn test-only` step): the tail ends with

```
1..16
# tests 66
# suites 10
# pass 61
# fail 2
# cancelled 0
# skipped 3
# todo 0
# duration_ms 4489.903129
```

— Node's own documented, stable `tap` reporter summary footer (the default reporter when stdout is not a
TTY, which is exactly the subprocess/CI case this harness always runs in). `# fail 2` is why `failures: 2`
was already correct; `# tests 66` sits four lines away and nothing has ever read it.

**This is not specific to babel-loader.** The footer shape is TAP's own summary convention, not a
babel-loader string — any repository whose CI runs `node --test` (a growing, ecosystem-standard choice
since Node 20) hits the identical gap.

## Design

**One new branch in `countsOf()`**, matching the existing Jest/Mocha branches' own style — a regex over
the runner's own summary line, never zero unless the summary line itself says so, undefined when the
summary line is absent:

```ts
// TAP (`node --test`, and any other TAP-protocol producer emitting the standard summary footer).
// Structural, not runner-specific: `# tests N` is TAP's own summary convention, matched nowhere else.
const tapTests = /^# tests (\d+)\s*$/m.exec(output);
if (tapTests) {
  const tapSuites = /^# suites (\d+)\s*$/m.exec(output);
  // testFiles is deliberately NOT populated from `# suites N` here - see "What this does not attempt".
  return { tests: Number(tapTests[1]) };
}
```

Placed as a **new, additional** branch — checked in an order that cannot regress an existing match: Jest's
`Tests:.*?total` and Mocha's `passing`/`failing` lines never contain a bare `^# tests \d+$` line, so
ordering relative to them is not load-bearing, but the branch is added last regardless, so the two
existing, already-correct branches are tried first and nothing about their behaviour changes.

**Named generically (`tap`), not `node:test`.** The signal being matched is TAP's own summary-line
convention, not something specific to Node's implementation of it — matching the same reasoning
`packageManagerCommand` and `isNodeTestRunner` (`purpose.ts`, SEMANTIC_REPAIR_02) already used: name a
rule after the structural thing it recognises, not after the one repository that happened to surface the
gap.

## Pre-registered invariants

1. **Existing Jest/Mocha behaviour is unchanged, provably.** The new branch is additive, checked after
   both existing ones return nothing; no existing regex, order, or return shape is touched. Verified by
   running the full suite and, specifically, `tests/scripts/test-output-parsers.test.ts` and any existing
   `countsOf` callers unmodified.
2. **Recognition is structural.** The regex matches the TAP summary line's own fixed shape
   (`^# tests \d+$`), not any babel-loader-specific string, test name, or package name. A fixture using
   invented test names / a different repository entirely, with the same summary footer shape, must parse
   identically.
3. **Counts are derived only when the output actually supports them.** No `# tests N` line, no `tests`
   returned — `{}`, exactly like today's Jest/Mocha branches on output they don't recognise. A truncated
   or killed run whose output stops before the summary footer prints must not produce a count, not even a
   partial one inferred from counting `ok`/`not ok` lines seen so far — that is precisely the "malformed
   partial output becomes a fabricated successful suite" failure mode this plan exists to avoid, so
   counting individual markers is explicitly rejected as a technique, not merely unneeded.
4. **The primary criterion is truthful representation, not a verdict.** Whether babel-loader's frozen
   output, run back through the fixed `countsOf()`, now yields `tests: 66` is the thing to verify.
   Whether `classify()` subsequently reports something other than `DIVERGED` for a *fresh* run is a
   separate, downstream fact to observe and report — not the acceptance bar, and not assumed either way
   before the fixed parser is actually run against fresh execution. (The frozen artifact itself cannot
   change outcome, only inform whether the parser now reads it correctly — a genuinely new run is needed
   to see what `classify()` does with a fresh pair of arms.)
5. **Rerun babel-loader plus the existing regression controls** after the change — the same five-repo
   discipline every prior phase in this thread has used, verified via the real deployed harness, not only
   locally.

## What this does not attempt

- **`testFiles` for TAP output.** Node's `# suites N` counts TAP `type: 'suite'` entries, which include
  *nested* `describe()`-style groupings (confirmed in the frozen fixture: `# Subtest: webpack` and
  `# Subtest: rspack` are themselves suites containing further suites), not a flat file count the way
  Jest's `Test Suites: N total` or Vitest's `Test Files N (M)` are. Mapping it to `testFiles` — consumed
  elsewhere by the economic eligibility gate as a cost-per-file denominator — would silently misrepresent
  what was measured. Left unset for this format; a real fix, if ever needed, requires establishing what
  `# suites N` actually means across representative TAP-producing repositories first, not assumed here.
- **Merging `parseTestOutput()` and `countsOf()` into one module.** They serve different, already-correct
  consumers (mutation-recall vs. `classify()`) with different questions ("did anything fail" vs. "did a
  real suite run"); unifying them is a larger refactor this plan does not need and does not attempt.
- **A Vitest branch for `countsOf()`.** Out of scope — no repository in this thread's frozen five uses
  Vitest, and `parseTestFileCount()` already has separate Vitest handling for its own, different consumer.
  Not touched here.

## Sequence

```
inspect frozen babel-loader TAP output (done, above)
  → identify the exact parser gap: countsOf() has no TAP branch; parseTestOutput()'s unrelated node:test
    adapter was never the problem (done, above)
    → this freeze
      → implement: one additive branch in countsOf()
        → parser fixtures: babel-loader's real frozen footer, a truncated/no-footer negative case, a
          structural (non-babel-loader) TAP fixture proving criterion 2
          → full suite
            → the real pinned babel-loader repository, fresh execution
              → the five-repo regression, real harness
                → freeze evidence
```
