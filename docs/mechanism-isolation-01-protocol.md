# FROZEN — MECHANISM_ISOLATION_01

**Written before the eligible pool was enumerated and before anything was drawn.**

## The question, narrowly falsifiable

> Can DiffCI reach and detect an affected test through its dependency/impact mechanism **when direct
> changed-file selection cannot**?

GENERATION_C_01 ended `RECALL_CONFIRMED` with **0 graph-reached selections**: both selected files were
files the commit touched, so a trivial changed-file rule would have matched the selection, the detection
and the cost exactly. The saving was real; the *cause* was not dependency intelligence. This experiment
isolates that cause and nothing else.

## The eligible shape, precommitted

A candidate is eligible when, under the **unchanged** `select-source-candidate` filter plus A1:

- it changes **at least one implementation source file**, and
- it changes **ZERO test files**, and
- it modifies no global-risk file (`package.json`, lockfiles, `tsconfig*`, runner/tooling configs,
  `.github/`, dotfiles), and
- it is not dependency automation, and
- it changes 1–5 implementation files.

The only addition to the frozen filter is the **zero-changed-test** requirement. That is the shape under
test, declared here, not discovered later.

## Repository

`jest-community/eslint-plugin-jest` @ `c7bf004e` — **already drawn blind** in Step 5.3 from a
third-party ordering, already qualified GREEN, already registered with commands derived from its own
manifest. Reusing it keeps the apparatus proven and adds no new choice of mine.

**A property of this repository that makes the isolation sharp**, recorded before any draw: its
`jest-runner-eslint` project lints every `.js`/`.ts` file, so a *changed implementation file is itself in
the test universe and is selected directly*. The mechanism question therefore becomes precise —

> does DiffCI additionally reach the **unchanged** test file (e.g. `valid-expect.test.ts` when
> `valid-expect.ts` changes), and does that reach detect the defect?

Linting a reverted file does not detect a behavioural regression. So direct-only selection is expected to
**miss**, and only a graph-reached test can catch it.

## The draw

```
pool  = every eligible candidate in history order, enumerated mechanically, sealed before drawing
H     = the full 40-hex hash of the commit that seals the pool
seed  = sha256(H)
index = uint32(first 8 hex of seed) mod |pool|
```

Same construction as the Step 5.3 repository draw: the seed comes from a hash that **does not exist**
when this rule is written. One draw, no redraw — not for selection size, not for whether the candidate
looks likely to reach through the graph, not for anything.

**No candidate is chosen because I inspected its graph.** Nothing in the pool is analysed before drawing.

## The arms

```
1. baseline       full suite, unmutated head          must be GREEN
2. mutate         revert one changed implementation file to its base content
3. full mutant    all 174 files                        expected DETECT
4. comparator     the path-rule selection              DETECT / MISS
5. DiffCI         DiffCI's selection                   DETECT / MISS
6. DIRECT-ONLY    ONLY the files the commit changed    DETECT / MISS      ← the isolating arm
```

Arm 6 was added to `dogfood-mutate` before this protocol was frozen, and is the whole point: without it,
"DiffCI detected it" cannot distinguish dependency reasoning from running the diff.

## The outcomes, all three declared in advance

| result | meaning | what follows |
|---|---|---|
| **direct-only MISSES, DiffCI DETECTS** | the graph reached something no trivial rule could | mechanism earns its existence → optimise precision and savings |
| **both DETECT** | the diff sufficed; the graph is unproven here | mechanism needs work → improve via continuous evaluation, **not** a new safety programme |
| **full DETECTS, DiffCI MISSES** | false green | stop optimisation, repair the safety mechanism |

`RECALL_UNMEASURABLE` (the full suite does not notice the revert) stays in the denominator and is
reported as itself.

**This chapter closes on the result either way.** A negative answer is not grounds for Generation E.

## Fixed in advance

- One draw, one candidate, one mutation. No substitution for any reason.
- No analyser change between this freeze and the result. Agent stays `sha512-eQGRE3ep…`, asserted at
  pack time.
- Economics reported under the unchanged definitions; within-run comparison only.
- The claim language stays: *same detected outcome at lower compute; causal contribution of graph
  intelligence established or not established by this experiment.* No "13.4× smarter CI".
