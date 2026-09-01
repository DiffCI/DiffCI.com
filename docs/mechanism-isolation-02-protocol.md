# FROZEN — MECHANISM_ISOLATION_02

**Written before the pool was enumerated and before anything was drawn.** The final bespoke mechanism
experiment.

## The question — the missing detection half

MI-01 established **reach**: DiffCI selected a test the commit did not touch, found through the
dependency graph. It could not establish **detection**, because the drawn refactor was
behaviour-preserving and the full suite never failed.

> **Does a graph-reached test actually change the DETECTION outcome — i.e. is it necessary to catch a
> regression that direct changed-file selection misses?**

## The eligibility rule, frozen prospectively

A candidate is eligible when, under the **unchanged** `select-source-candidate` filter plus A1:

- it changes **at least one implementation source file**;
- it changes **ZERO test files** — the isolation shape, unchanged from MI-01;
- its subject matches, **mechanically**, `/^fix(\([^)]*\))?!?:/` — a conventional-commit fix;
- no global-risk file, not dependency automation, 1–5 implementation files.

### What the fix criterion may and may not use

It reads the **commit subject line and nothing else**. That information exists in the repository's own
history, authored by its maintainers, long before DiffCI ever looked at it.

**Explicitly forbidden as inputs, and not consulted:** graph structure, DiffCI selections, observation
results, mutation outcomes, predicted or measured savings, test-file contents, and any judgement of mine
about whether a given fix "looks testable". The rule is a regex over a string the repository wrote.

The rationale is mechanical, not aspirational: a commit whose author declared it a fix is more likely to
have changed behaviour than one declared a refactor. That is a **prior**, not a guarantee — MI-02 may
still land on a fix whose revert the suite cannot see, and that outcome is accepted below.

## Sequence

```
freeze rule → enumerate pool → seal pool → seed = sha256(pool-sealing commit hash)
            → ONE blind draw → no redraw → observe → mutate → four arms
```

The seed derives from a commit hash that does not exist while this rule is being written.

## The four arms

```
1. baseline      full suite, unmutated head        must be GREEN
2. full mutant   all files                          gate: no failure here ⇒ RECALL_UNMEASURABLE
3. comparator    the path-rule selection            DETECT / MISS
4. DiffCI        DiffCI's selection                 DETECT / MISS
5. DIRECT-ONLY   only the files the commit changed  DETECT / MISS    ← the discriminator
```

## The decisive matrix, declared in advance

| full | direct-only | DiffCI | verdict |
|---|---|---|---|
| detects | **misses** | **detects** | **dependency-mechanism detection DEMONSTRATED** — the bridge |
| detects | detects | detects | detection succeeds, **graph causal contribution unproved** |
| detects | — | **misses** | **FALSE GREEN** — stop savings optimisation, repair safety |
| **does not detect** | — | — | `RECALL_UNMEASURABLE` — close it as such |

## The boundary that matters most

**MI-02 is the last bespoke mechanism experiment.** If it comes back unmeasurable again, that is the
answer for now: the apparatus moves into continuous evaluation and effort goes to the product
trajectory. **There is no MI-03 because we dislike the draw.**

Written here, before the result, because the temptation to run "just one more" is strongest exactly when
the previous one was uninformative.

## Fixed in advance

- One draw, one candidate, one mutation. No redraw for any reason.
- No analyser change between this freeze and the result; agent stays `sha512-eQGRE3ep…`, asserted at
  pack time.
- Economics under the unchanged definitions, within-run comparison only, and reported as **replication
  evidence** unless paired with a measured detection outcome.
- Claim language unchanged: no "smarter CI", no mechanism claim without the direct-only arm missing.
