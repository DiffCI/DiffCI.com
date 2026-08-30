# vuejs/core: why each selected file was selected

**Raw causal provenance, frozen before deciding whether any reason is necessary.** Artifact:
`docs/evidence/vue-selection-traces.json`.

Establishing *why* a file was selected and deciding whether it *should* have been are two different
experiments. Only the first is done here. Nothing about selection behaviour was changed.

## Fidelity

This traces `src/` directly rather than the packaged agent, so it is only meaningful if it reproduces
the frozen counts. One representative commit per bucket, all five exact:

```
31da934fc  expect 57  -> 57   MATCHES
f8d42e1cf  expect 97  -> 97   MATCHES
cd1974562  expect 98  -> 98   MATCHES
b8543dcf0  expect 162 -> 162  MATCHES
ef82a2677  expect 183 -> 183  MATCHES
```

## Every selected file has a real dependency path

```
commit       selected  DEPENDENCY  DIRECT_TEST_CHANGE  no-chain  fallback  graph confidence
31da934fc          57          57                   1         0     false  COMPLETE
f8d42e1cf          97          97                   1         0     false  COMPLETE
cd1974562          98          97                   1         0     false  COMPLETE
b8543dcf0         162         162                   1         0     false  COMPLETE
ef82a2677         183         183                   2         0     false  COMPLETE
```

**Files with no recorded dependency chain: 0, on every commit.** No conservative fallback, no
`CONFIG_GLOBAL`, no `ALWAYS_RUN_POLICY`, no `UNKNOWN_FILE`, no `GRAPH_CONFIDENCE_UNSAFE`. Graph
confidence was `COMPLETE` and `fallbackRequired` was `false` throughout.

Against the three outcomes named in advance, this is **outcome 1 at the file level**: every selection is
auditable and every edge is real. It is **not** outcome 3 — there is no unexplained selection.

## The mechanism: barrel re-export collapse

Every chain runs through a package's `src/index.ts`.

```
style.ts          -> runtime-dom/src/patchProp.ts -> runtime-dom/src/index.ts -> reactivity/__tests__/ref.spec.ts
componentEmits.ts -> runtime-core/src/index.ts -> runtime-test/src/index.ts -> reactivity/__tests__/computed.spec.ts
errors.ts         -> compiler-core/src/index.ts -> compiler-core/__tests__/codegen.spec.ts
looseEqual.ts     -> shared/src/index.ts -> compiler-core/__tests__/codegen.spec.ts
```

Quantified across every chain, not inferred from examples:

```
commit       selected  chains via a barrel   dominant barrel
31da934fc          57        52  (91%)       runtime-dom/src/index.ts    52
f8d42e1cf          97        68  (70%)       runtime-core/src/index.ts   44
cd1974562          98        67  (69%)       runtime-core/src/index.ts   43
b8543dcf0         162       155  (96%)       compiler-core/src/index.ts 155
ef82a2677         183       183 (100%)       shared/src/index.ts        183
```

Median chain length is 4–5 hops.

**This explains all three observations at once:**

- **Why the buckets are byte-identical.** The closure is determined by *which package* was touched, not
  which file. Any change under `packages/runtime-core/src/` reaches `runtime-core/src/index.ts` and
  from there the same dependents — so different commits touching different files in the same package
  produce the identical selection.
- **Why the sizes are 57 / 97 / 162 / 183.** They are the reverse-dependency closures of the
  `runtime-dom`, `runtime-core`, `compiler-core` and `shared` barrels. `shared` is imported by
  everything, so touching one utility selects 183 of 196 test files.
- **Why the economics are poor.** `ef82a2677` changed `packages/shared/src/looseEqual.ts` — a single
  equality helper — and selected 183 of 196 files, costing 125.34 CPU-s against a comparator's 10.48.

## The precise nature of the imprecision

Every edge is genuine: `looseEqual.ts` really is re-exported by `shared/src/index.ts`, which really is
imported by `compiler-core`'s tests. The **file-level** graph is correct.

What it cannot see is that `codegen.spec.ts` imports `shared/src/index.ts` for something other than
`looseEqual`. A barrel makes file-level dependency a poor proxy for symbol-level dependency, and barrel
files are near-universal in TypeScript monorepos.

So this is not a bug in the sense of a wrong edge. It is a **granularity limit**: file-level reachability
through a re-export hub.

## Negative control

The union of selections across all 16 candidates is 184 of 196 test files; 12 are never selected. The
184 span every package, concentrated where the dependency fan-in is largest:

```
44 runtime-core   20 compiler-core   19 compiler-sfc   17 server-renderer
16 reactivity     16 runtime-dom     15 compiler-ssr   12 compiler-dom
11 vue-compat      8 vue              5 shared          1 runtime-test
```

## What is deliberately not concluded

Whether any of these selections is *unnecessary* is a separate experiment and is not answered here. A
test importing a barrel may genuinely depend on the changed symbol; establishing otherwise requires
symbol-level analysis that does not exist yet.

Nor does this justify a selector change. The finding is that Vue's cost is explained by barrel-mediated
file-level closure — which is a hypothesis about a **mechanism**, now supported by traces, and the
obvious next question (does symbol-level resolution through re-export hubs materially reduce the
closure?) is itself an experiment rather than a fix.
