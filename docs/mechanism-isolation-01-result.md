# MECHANISM_ISOLATION_01 — result

Run `mi-mutate-01`. Protocol and pool frozen at `614b385`, target drawn from the hash of that commit.

```
target   209e8f3c1  refactor: use shorthanded object property (#1622)
base     e496de526
changed  src/rules/prefer-jest-mocked.ts        (1 file, ZERO test files)
```

## The mutation outcome: RECALL_UNMEASURABLE

```
reverting src/rules/prefer-jest-mocked.ts did NOT fail the full suite
```

The refactor is behaviour-preserving, so undoing it changes nothing the tests observe. **The comparator
and direct-only arms therefore never ran** — with no full-suite failure there is nothing to detect, and
running them would measure nothing.

This was written into the commit message **before** the run: *"this is a refactor… the full suite may not
notice the revert at all. That yields RECALL_UNMEASURABLE, which the frozen protocol keeps in the
denominator and reports as itself."* It stays in the denominator. There is no redraw.

## The observation, which IS informative — and is the first of its kind here

| | |
|---|---|
| decision | `SELECTIVE`, `SAFE_TO_PROPOSE` |
| selected / universe | **2 / 131** (comparator 123) |
| `DIRECT_CHANGED` | 1 — `src/rules/prefer-jest-mocked.ts` |
| **`GRAPH_REACHED`** | **1 — `src/rules/__tests__/prefer-jest-mocked.test.ts`** |

**The commit did not touch that test file.** DiffCI reached it through the dependency graph. Under the
corrected selection-cause classifier, this is the **first recorded `GRAPH_REACHED` selection** in this
project — GENERATION_C_01 had zero.

A trivial changed-file rule would have selected only `prefer-jest-mocked.ts`. DiffCI selected that plus
the test that exercises it, which the diff alone cannot find.

## What this does and does not answer

The frozen question was: *can DiffCI **reach** and **detect** an affected test through its dependency
mechanism when direct changed-file selection cannot?*

- **Reach: demonstrated.** One graph-reached test, on a candidate drawn blind within a precommitted
  shape, with no candidate inspected before drawing.
- **Detect: NOT demonstrated, and not refuted.** The drawn mutation is invisible to the suite, so
  whether that reach *catches* a regression is unmeasured.

**Half the question is answered.** Reporting this as a mechanism win would be exactly the overreach this
protocol was built to prevent: reaching a test proves the graph found something, not that finding it
mattered.

## Economics, measured on the unmutated tree

```
full         59.08 CPU-s   (131 files)
comparator   52.00 CPU-s   (123 files)
DiffCI        6.30 CPU-s   (2 files)
joint analysis 1.89 CPU-s  (charged entirely to DiffCI)

incremental vs comparator = 52.00 − (6.30 + 1.89) = +43.81 CPU-s
gross versus FULL         = 59.08 − 8.19          = +50.89 CPU-s
```

Consistent with GENERATION_C_01's +71.48, on a different commit of the same repository. Within-run
comparison only.

## Where this leaves the chapter

The protocol declared three outcomes and said the chapter closes on any of them. The actual outcome is
the fourth one it also anticipated — **unmeasurable** — which resolves neither *positive* nor *negative*.

What is now established, precisely:

1. DiffCI **can** reach a test the diff cannot (n = 1, observed).
2. Whether that reach **detects** anything is still unmeasured (n = 0 measurable).
3. The economics hold at ~+44 to +71 CPU-s incremental across two candidates of one repository.

**The honest claim remains what it was:** same detected outcome at dramatically lower compute on the
blinded case; the causal contribution of graph intelligence is **partially** evidenced — reach yes,
detection not yet.

## The decision I am not making alone

The protocol forbids a redraw, and I have not made one. Resolving the detection half needs **one more
draw from the same sealed 18-entry pool**, minus the drawn entry, under the same rule — and that is a
new authorisation, not something to help myself to because the first answer was inconvenient.

A cheaper alternative worth weighing: the pool's `fix:` commits are likelier to be behaviour-changing
than its `refactor:` commits. But **filtering the pool toward fixes after seeing this result would be
selecting for a measurable outcome**, which is the same error in a new coat. If the shape is narrowed, it
must be narrowed as a precommitted rule in a fresh experiment, not as a repair to this one.
