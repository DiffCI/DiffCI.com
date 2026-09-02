# Sample member 5 — `babel/babel-loader` @ `778e7c54d` — **R3_FAILED / REFERENCE_NON_DETERMINISTIC**

```
exit 0   corepack enable          0.1s
exit 0   yarn                    12.3s
exit 0   yarn add -D webpack@5    3.6s
exit 0   yarn up @babel/*@^7      5.2s   spawnedWithoutShell = true
exit 0   yarn run build           1.5s
exit 1   yarn test-only           4.5s   66 tests, 61 pass, 2 fail, 3 skipped
```

Amendment 5 worked exactly as intended: `yarn up @babel/*@^7` executed with **no shell**, exit 0, and the
receipt records `spawnedWithoutShell: true`. The metacharacter never crossed a shell boundary and the
step was not rejected either.

## Why the suite failed — established, not guessed

Both failures are in `test/cache.test.js`, asserting on the **content of webpack's build log**:

```
not ok 10 - should output debug logs when stats.loggingDebug includes babel-loader
  error: The input did not match the regular expression
         /normalizing loader options\n\s+resolving Babel configs\n\s+cache is enabled\n…/
  actual: 'asset main.js 5.52 KiB [emitted] (name: main)
           …
           webpack 5.110.3 compiled successfully in 52 ms'
```

The decisive pair of dates:

| | |
|---|---|
| pinned commit `778e7c54d` | **2026-08-04** |
| `webpack@5.110.3` published | **2026-09-01** |

The workflow installs `yarn add -D webpack@5` — a **floating range resolved against the live registry at
install time**. The reference arm therefore built against a webpack released **28 days after** the commit
whose CI passed. That version did not exist when the ground-truth run went green.

This is not inference from a plausible story. The commit is pinned; its dependency graph is not.

## Classification, and an honest note about the label

`R3_FAILED`. Under the frozen vocabulary the catch-all for a failed R3 is `ENVIRONMENT_INADEQUATE`, and
that label would be **wrong here** — the container is entirely adequate. It has node, corepack, yarn, and
it ran the build and 61 passing tests.

So this member is recorded as **`REFERENCE_NON_DETERMINISTIC`**, and two things about that label must be
stated plainly:

1. **It was introduced after observing the result.** The frozen protocol asked for "at least" the six
   listed outcomes, so distinguishing a new one is permitted — but adding a label post-hoc is exactly the
   move that deserves suspicion, so it is flagged rather than slipped in.
2. **It cannot flatter DiffCI, because the engine never ran on this member.** R3 is a gate. Whatever the
   label, member 5 contributes nothing to DiffCI's score in either direction. That is what makes a
   post-hoc descriptive label acceptable here: it changes no judgement about the system under test.

## What it demonstrates

This is the most concrete evidence in the whole sample for the thing eslint's refusal was *about*.

eslint was refused for lacking a **pinned dependency basis**, and that refusal graded `CORRECT_REFUSAL`
on a structural check — no lockfile, no `packageManager`. Member 5 shows the same property doing damage
empirically: a repository whose CI passed on 2026-08-04 produces **two failing tests today**, from
nothing but registry drift.

An engine that refuses to optimise a pipeline it cannot pin is not being over-cautious. It is declining
to promise a result that the pipeline itself cannot promise.

## A limit on the whole reproduction method, worth stating

Reproducing a historical CI run requires the run to be reproducible. Where a pipeline installs floating
ranges, **its own past is not reproducible either** — by anyone, including its maintainers. Any future
reproduction sample should record, per candidate, whether the pipeline pins its dependencies, because
that determines whether the question can be answered at all.

That check does not exist in the frozen R1–R4 criteria. It should have.
