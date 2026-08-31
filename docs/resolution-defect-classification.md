# Three unmapped-import traces: two converge, one does not

Diagnostic only. **Nothing in the analyser was modified.** The question was whether the 0% mapping band
hides one generic resolver defect or several unrelated ones, and the answer is: **one generic defect
covering two of the three, and a different, deeper problem in the third.**

## A — `typescript-eslint`: project-reference expansion is gated on the wrong condition

**Graph: 310 nodes, 1 edge. 308 of those nodes are tests; exactly 2 are non-test files** (`vitest.config.mts`,
`vitest.config.base.mts`). The repository's entire source is absent from the graph.

The cause is one line, `src/repo/graph.ts:421`:

```ts
if (fileNames.length === 0 && parsed.projectReferences && parsed.projectReferences.length > 0) {
```

Solution-style expansion runs **only when the root config yields zero files**. typescript-eslint's root
`tsconfig.json` has `"files": []` but parses to **3** file names and **19** project references — so the
gate is false, the references are never expanded, and the program is built from three files.

TypeScript's own APIs resolve it correctly, two levels down:

```
root tsconfig.json                       fileNames 3    projectReferences 19
  packages/ast-spec/tsconfig.json        fileNames 0    projectReferences 2
    packages/ast-spec/tsconfig.build.json  fileNames 253
    packages/ast-spec/tsconfig.spec.json   fileNames 20
  packages/eslint-plugin/tsconfig.json   fileNames 0    projectReferences 3
    …/tsconfig.build.json                  fileNames 236
    …/tsconfig.spec.json                   fileNames 201
```

`resolveProjectReferenceInputs()` is already recursive and already correct. It is simply **never
called** here. The gate should ask "does this config have project references?", not "did it yield zero
files?" — a solution tsconfig can legitimately contribute a few root files and still need expansion.

Note also `packages/parser/tsconfig.json` is itself `files: [] , include: [], references: [...]` — the
nesting is **two levels deep**, which the existing recursion already handles.

## B — `babel`: the same defect, partially masked

**Graph: 511 nodes, 1,659 edges. 421 of 697 `packages/*/src` files present — 60% coverage.**

Babel's root config also has project references that are never expanded, for the same reason. It looks
healthier only because its root `include` (`"dts/packages*.ts"`, `"*.mts"`, `"*.ts"`, `"scripts*.ts"`,
`"packages/*/test/*.tst.ts"`) happens to pull in ~500 files directly. Two-fifths of Babel's package
sources are still missing.

**This is the generalisation test the third trace was for, and it passes: A and B are the same defect
with different visible severity.** typescript-eslint is catastrophic because its root include is empty;
Babel is merely incomplete because its root include is broad.

## C — `react`: a different problem, and a harder one

**Graph: 2,406 tests, 13 edges.** Two independent causes, neither of which is the gate above:

1. **No root `tsconfig.json` at all.** The only tsconfigs live under `compiler/`, a separate sub-project.
   The analyser falls into its `discoverNestedTsconfigPaths` branch and builds a graph of React's
   *compiler* subtree — while React's actual library source is **Flow-typed JavaScript outside any
   TypeScript project**. There is no TS program that contains it.

2. **Tests import by package name.** A representative test:

   ```js
   React = require('react');
   ReactDOMClient = require('react-dom/client');
   ({…} = require('internal-test-utils'));
   ```

   These resolve through Jest's `moduleNameMapper`/Haste configuration to `packages/react/src/…`. That
   mapping is real and static, but it lives in the **Jest config**, not in the module graph. Resolving
   it means reading and interpreting the test runner's own resolver configuration.

Fixing A would not move React at all.

## Classification, in the terms agreed

| class | meaning | repositories seen |
|---|---|---|
| **A — repository structurally opaque** | tests carry no static dependency information | `prettier` (global runner via `setupFiles`) |
| **B — source unavailable at analysis time** | tests import generated artifacts absent from source | `chai` (`../index.js` is built, not committed) |
| **C — DiffCI resolver/scope incomplete** | statically expressed relationships DiffCI fails to connect | `typescript-eslint`, `babel` (**one gate**); `react` (**separate: no TS project over the source, plus runner-config module mapping**) |

Class C splits into **C1** — the project-reference gate, one condition, affects an unknown number of
the 0% band — and **C2** — repositories whose source is not in any TypeScript project and whose tests
map through runner configuration. C2 is a much larger piece of work and should not be conflated with C1
when estimating what a fix buys.

## What a C1 fix would and would not buy

**Would:** restore source coverage for TypeScript monorepos using solution-style roots — the standard
layout. Directly affects `typescript-eslint` (2 frame entries) and `babel` (5). Whether their mapping
density then rises is **unmeasured** — the sources being present is necessary, not sufficient.

**Would not:** touch `react`/`react-dom` (2 entries), `prettier`, `chai`, or `DefinitelyTyped` (3).

So the honest expectation is that a C1 fix moves **up to 7 of the 20** in the 0% band, with the actual
gain unknown until measured. It is not a fix that plausibly rescues the whole band.

## Recommended sequence, not yet taken

1. Fix the C1 gate — change the condition, not the recursion, which is already correct.
2. Add semantic regression cases: a solution-style root that yields a few files **and** has references;
   two-level nesting; a root whose `include` partially covers packages.
3. Re-run the **same frozen 40-repository frame**. Do not add repositories.
4. Freeze the before/after as *coverage gained through resolver correctness alone*.
5. Only then define the compute-proof eligibility rule mechanically, and select from whoever qualifies.

**No code has been changed.** The traces are recorded so the before-state is auditable.
