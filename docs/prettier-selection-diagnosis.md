# Why Prettier selects nothing: its tests do not import their subject

**Non-canonical developer-host diagnostic**, one preselected candidate, analyser at `51ddf74`.

## The candidate, chosen by rule before any result existed

`893fd3b1` — *Add `isTypeAnnotation` (#19921)*, base `bb52ae36`. Selected at
[`e66f4fa`](evidence/prettier-diagnostic/candidate-02-selection.txt) by a mechanical filter: 5
implementation files under `src/language-js/`, no test files, no `package.json`, no lockfile, no
config, not dependency automation. The first match in history order after examining 18 commits.

Because it changes no tests, any test DiffCI selects must be reached **through the graph** — a strictly
harder and more informative case than a commit that edits its own tests.

## The funnel

```
changed files                    5
graph nodes                   2201        (1663 tests + 513 src + others)
graph edges                   1574
graph confidence (raw)      UNSAFE
graph confidence (effective) COMPLETE
affected source files          105        <- graph reachability WORKS
test universe                 1667
tests recognised by discovery 1667        <- discovery WORKS, all present as nodes, all flagged
affected tests (mapped)          0        <- the zero appears HERE
analysis status      SAFE_TO_PROPOSE
fallbackRequired             false
FINAL decision           SELECTIVE
FINAL selected tests             0
comparator selected           1663
```

Every stage before test mapping is healthy. Five changed files reach **105** affected source files, so
traversal is doing real work. All 1,667 tests are discovered, present as graph nodes, and flagged as
tests. The collapse is at exactly one boundary: **affected source files → tests**.

## The cause

**1,419 of 1,464 Prettier test files contain no `import` or `require` at all.** A representative one is
a single line:

```js
runFormatTest(import.meta, ["angular"]);
```

`runFormatTest` is a **global**, assigned in `tests/config/format-test-setup.js` (`globalThis.runFormatTest = …`)
and injected through Jest's `setupFiles`. The test never names its subject. There is no static edge from
the test to `src/`, and none can be inferred from the file's text.

That is why the graph has only **1,574 edges for 2,201 nodes** — fewer edges than nodes. The 1,663 test
nodes are almost all isolated.

**This is not a DiffCI defect.** A file-level static import graph cannot connect a test that imports
nothing. It is a property of Prettier's test architecture, and the analyser's response — `SELECTIVE`
with an empty set rather than a fabricated one — is the conservative behaviour the safety policy
intends.

## What this establishes, and what it does not

**Establishes:** for this candidate, the empty selection is fully explained. Test discovery, graph
construction and reachability all work; the mapping step has nothing to work with because 97% of the
test universe has no static dependency on anything.

**Does not establish:** that this explains the other 24 Prettier candidates, immer's `0/4`, or
cross-env's empty SELECTIVE decisions. One candidate, and no claim beyond it.

**Does not establish** anything about recall or safety. No mutation ran.

## The applicability limit this exposes

A third constraint, alongside the `tsconfig.json` requirement and the harness gates:

> DiffCI's file-level static import graph can only map tests to sources when tests **statically import
> what they exercise**. Suites driven by globals, dynamic fixture discovery, or a shared runner
> injected through framework setup are invisible to it.

This is orthogonal to repository size and to language. It is a property of how a suite is written.

Prettier is an extreme case — 97% import-free — but the pattern is not rare: snapshot/fixture-driven
suites, Cucumber-style step definitions, and anything using a globally injected harness share it.

## Timing, for the record

```
eligibility        1 ms
gitDelta         267 ms
graphBuild      8411 ms
impactAnalysis   159 ms
pathBaseline       4 ms
TOTAL            8.8 s   (cpu 10.0 s, ratio 1.13)
```

The analyser cost is now ~4% of Prettier's 214-second full suite, against ~281% before `51ddf74`. That
is a diagnostic-run figure on a developer host and **is not a product claim**.

`graphBuild` is now the dominant phase at 8.4 s, driven by 19,277 `statSync` calls over 2,392 distinct
paths. Worth noting; not worth acting on yet.
