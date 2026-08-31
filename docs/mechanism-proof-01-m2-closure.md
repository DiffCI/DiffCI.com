# M2 closed — the reported denominators were roughly double the runner's

Resolved **without changing or rerunning the experiment**: by reading `jest.config.ts` at the pinned
tree and enumerating the files it matches. No container run, no new measurement, nothing in
`tsjest-mutate-01` touched.

## The finding

```
jest.config.ts @ b1a97ac4:   testMatch: ['<rootDir>/src/**/*.spec.ts']
                             no testPathIgnorePatterns
```

| | count |
|---|---|
| files matching jest's `testMatch` | **20** |
| test-suffixed files in the whole tree | **40** |
| under `src/` (jest runs these) | 20 |
| under `e2e/` and `examples/` (jest never runs these) | 20 |

20 at every one of the five candidate commits, not just the pinned head.

**DiffCI's reported test universe of 40 is exactly the whole-tree count.** Its discovery counts 20
`e2e/` and `examples/` spec files that this jest configuration does not execute. The qualification
figure of 20 was the correct one; the survey and observation denominators were wrong.

## The correction, which makes the numbers WORSE

Every reported selection fraction overstated its denominator by roughly 2x:

| candidate | reported | **true, against the runner's 20** |
|---|---|---|
| 1 `06c79d4ce` | 7/40 = 17.5% | **7/20 = 35.0%** |
| 2 `394181875` | 7/38 = 18.4% | **7/20 = 35.0%** |
| 3 `a82a2b32c` | 7/38 = 18.4% | **7/20 = 35.0%** |
| 4 `8a8fd2fb8` | 9/38 = 23.7% | **9/20 = 45.0%** |
| 5 `96d025dd9` | 2/38 = 5.3% | **2/20 = 10.0%** |

Candidate 5, the strongest result, selected **10% of the executed suite, not 5.3%.**

## What is NOT affected

- **The CPU economics.** Every figure in the result is measured wall/CPU from an executed arm, never
  derived from a count. `+213.20` incremental on candidate 5 and the three negatives stand exactly.
- **The safety result.** **Zero of DiffCI's selected tests, across all five candidates, fell outside
  jest's `testMatch`.** Checked explicitly — every selected path is `src/**/*.spec.ts`. So no selection
  was padded with a file the runner would silently skip, and no `RECALL_CONFIRMED` was obtained by
  selecting tests that never ran. Had that not held, the recall result would have been compromised.

## The defect this exposes

DiffCI's test discovery does not intersect its universe with the runner's own configuration. It found
every test-suffixed file in the tree, including two directory trees jest is configured never to touch.

On this repository the consequence was confined to reporting, because the extra 20 were never selected.
That is **not** a guarantee. A change under `e2e/` or `examples/` would plausibly have caused DiffCI to
select files the runner ignores — inflating the apparent selection while adding no detection at all,
and a mutation there would have been unmeasurable for a reason having nothing to do with the graph.

Recorded as a defect. Not fixed here: fixing discovery now would change the analyser between this frozen
result and any future one.
