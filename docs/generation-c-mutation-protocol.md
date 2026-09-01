# FROZEN — GENERATION_C_01 mutation protocol

**Written before any mutation result exists.** The observation it follows is frozen at `35fcca0`.

## The sealed subject, unchanged

```
repository   jest-community/eslint-plugin-jest @ c7bf004e
target       3629019d8 .. 58e487fec        (sealed b6f1bda, index 0 of 5)
subject      fix(prefer-to-have-been-called): don't crash on matcher without an argument (#2016)
impl         src/rules/prefer-to-have-been-called.ts
test         src/rules/__tests__/prefer-to-have-been-called.test.ts
observation  SELECTIVE, SAFE_TO_PROPOSE, 2 / 174, comparator 164 / 174
apparatus    generation C, agent sha512-eQGRE3ep…
manifest     bundle 9e17e3145826f78aab2e54db4a846da67771d56260e1c38f59d523eca0638b34
```

**Candidates 2–5 are not mutated and not substituted.** The target was sealed before any DiffCI output
existed; swapping to a more interesting candidate now would discard exactly the property the seal buys.

## The three arms

```
1. baseline           full suite, unmutated head       must be GREEN, else the candidate is dirty
2. mutate             revert src/rules/prefer-to-have-been-called.ts to its base content
3. full mutant        full suite, mutated tree         expected FAIL; if it PASSES → RECALL_UNMEASURABLE
4. comparator mutant  the 164 path-rule files          DETECTED / NOT DETECTED
5. DiffCI mutant      the 2 selected files             DETECTED / NOT DETECTED
```

with CPU and wall time on each arm.

## Two apparatus changes, both made BEFORE this protocol was frozen

**1. The comparator-mutant arm did not exist.** Amendment M3 recorded that `dogfood-mutate` measured
the comparator for cost on the clean tree and never for recall on the mutated one, so the middle column
of this matrix was unanswerable. It now runs the comparator's file list against the same mutation,
through the same runner, exactly as the DiffCI arm is run. Unmeasurable when no comparator list exists —
recorded as unmeasurable, never scored as a miss.

**2. Selection-cause attribution was wrong.** The observation classifier called any selected path absent
from `changedTestFiles` "production impact", which counted the changed *implementation* file as
graph-reached. Receipts now record `DIRECT_CHANGED` versus `GRAPH_REACHED`, where direct means the commit
touched the file at all. The originally emitted row is preserved unedited.

Neither change touches the analyser. The agent digest is unchanged at `sha512-eQGRE3ep…`, and that is
asserted at pack time rather than assumed.

## The outcome that disqualifies

```
full mutant = FAIL   and   DiffCI mutant = PASS      →   FALSE GREEN
```

Disqualifying, reported at the top of the result, never offset by savings.

## The outcome I expect, stated in advance so it cannot be spun afterwards

DiffCI selected the changed test file. The mutation reverts the implementation that this very test
exercises. **So the DiffCI arm will almost certainly detect it — and so will the comparator**, whose 164
files include that same test.

If that is what happens, the honest result is:

> **Safe selection, no unique mechanism advantage on this target.** DiffCI caught the defect; a trivial
> path rule caught it too; the graph contributed nothing on this candidate.

That is a real and reportable outcome, and it is written here **before** the run so that it cannot later
be dressed up as a success. A caught mutation is only evidence of mechanism value when the comparator
misses it.

## Economics, unchanged

```
CPU primary; wall time separate.
Incremental = C_comparator − (C_diffci_selected + C_joint_analysis); joint analysis charged to DiffCI.
Gross versus FULL alongside, never instead.
Install and build reported SEPARATELY, never as selection savings.
Negative savings preserved as measured.
WITHIN-run comparison only — the same suite varied ~20% across runs.
```

The universe is **174**, the runner's own (`jest-runner-eslint` matches every `.js`/`.ts` file). Fractions
are stated against that, not against a test-suffixed subset.

## What a clean result would and would not establish

**Would:** on a repository drawn at random from a third-party ordering, against a target sealed before
any DiffCI output, DiffCI's selection retained the test that detects the reintroduced defect.

**Would not:** graph value (both selections are direct), general safety (n = 1), or that this
generalises. One mutation on one candidate on one repository.

## Fixed in advance

- The result is reported whatever it shows, including `RECALL_UNMEASURABLE` or a comparator that also
  catches it.
- No re-mutation, no second target, no substitution.
- No analyser change between this protocol and the result.
