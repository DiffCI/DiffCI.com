# Positioning

**Status:** draft, not published. Decisions here drive [`02-homepage-copy.md`](02-homepage-copy.md).

## One site, two readers

The site is written developer-first. The investor case is not a separate story told in a different
register — it is the same story with the evidence section read carefully.

| Reader | Arrives wanting | Leaves having |
|---|---|---|
| **Developer / staff eng at a repo with slow CI** | To know whether their CI is wasting money, without risking their CI to find out | Installed a read-only App, or bookmarked the evidence page unconvinced but interested |
| **Investor / grant reviewer** | To know whether this is a real system with real measurement, or a demo with a landing page | Read the case studies and found the unflattering numbers still there |

The bridge between them is one page: **Evidence**. A developer skims it and believes the product. A
reviewer reads it and believes the team. That only works if it is genuinely honest, which is why the
44% figure sits beside the 91% figure and the 0.696 recall is not hidden.

## The core claim

> Most CI runs re-execute work that could not possibly have been affected by the change. DiffCI measures
> exactly how much of that your repository is paying for — before it ever touches your CI.

Three things make that claim defensible today:

1. **It is a dependency graph, not a heuristic.** A real TypeScript compiler-backed graph, reachability
   from the changed files, confidence-scored, with mandatory fallback to full CI when the change touches
   anything the graph cannot reason about (lockfiles, workflow files, root config).
2. **It has been forced to execute what it selected, and the execution was verified.** Not "we think
   these 3 tests suffice" — the selected set was actually run, and a runtime invariant checked that the
   test runner honored the selection exactly rather than quietly broadening it. 8 for 8 on cal.com; 4 of
   5 on deepseek-harness, with the fifth correctly labeled as a runner-scope limitation rather than
   counted as a success.
3. **It abstains.** Where evidence is missing, DiffCI reports `UNMEASURABLE` / `UNKNOWN` instead of
   producing a number. That behavior is enforced in the schema, not in the wording.

## The pitch, in the order it has to be made

**1. Nothing changes.** Shadow mode is read-only end to end. DiffCI clones and analyzes; it never writes,
comments, labels, skips, cancels, or blocks. The install has no CI authority to give away, so the
decision to try it is not a risk decision.

**2. We measure your repository, not an average.** The honest lesson from the two validated repositories
is that the number is *repository-specific*: identical selection quality produced ~44% job-level
reduction on cal.com and ~80–90% on deepseek-harness, entirely because of how much of each job is
install versus test. Anyone quoting you a single industry percentage has not measured your repository.

**3. Then you decide.** The report is the product's first deliverable. Activation — actually skipping
anything — is a separate, later, explicitly-granted step that does not exist yet.

## What DiffCI refuses to claim

These are positioning decisions, not disclaimers to be shrunk into a footer.

- **No headline percentage on the hero.** A single big number would have to come from an estimate, and
  the estimator overstates savings at small selection ratios because it models no fixed per-invocation
  overhead. The hero says what DiffCI *measures*, not what it *saves*.
- **No "X% faster CI" for anyone's production pipeline.** Nothing has ever been skipped in a real CI run.
  The savings figures are from controlled replays in DiffCI's own sandbox with the full and selected
  paths both executed and timed.
- **No customer logos, no testimonials, no "trusted by".** There are no customers. The repositories named
  in the case studies are public projects analyzed from public data; none of them use DiffCI or endorse it.
- **No safety guarantee.** The claim is "measured mutation recall on the cases where recall was
  measurable, with the unmeasurable ones counted and named" — 3 of 3 unique cases on cal.com, 3 of 3 on
  deepseek-harness. That is a real result on a small denominator, and the site says the denominator.
- **No prediction of test failures.** The preflight work's honest recall is 0.696, and every unit-test
  failure in that dataset was a miss. DiffCI's high-confidence coverage today is typecheck and
  configuration classes. Saying so is cheaper than being caught.

## Positioning against the obvious comparison

"Isn't this just test impact analysis / Nx affected / Turborepo cache?"

The answer is not that those are bad — it's that they answer a different question. Those tools tell you
what to run. DiffCI's product surface is the part nobody ships: **evidence that the decision was safe and
what it was worth**, reconciled against what the CI actually did afterwards. Selection is the input;
measured, hindsight-verified economics is the output. The case studies are the proof that the second half
exists.

## Tone

Plainspoken, technical, quantified, and comfortable saying "not measured yet." The reader we want is the
one who has been pitched a CI-savings number before and did not believe it. Every place the copy is
tempted to round up is a place to state the denominator instead.
