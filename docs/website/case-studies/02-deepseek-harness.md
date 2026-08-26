# Case study — deepseek-ai/deepseek-harness

**Status:** draft, not published. Numbers traced in [`../03-evidence-ledger.md`](../03-evidence-ledger.md).

> **deepseek-harness is not a DiffCI customer.** It is a public open-source repository with public CI.
> Everything below was produced by analyzing its public source and replaying its own test suite in
> DiffCI's sandbox. Nobody associated with the project was contacted, and nothing here is an endorsement.
> No change was ever proposed to, or made in, its real CI.

---

## Why this repository

cal.com is the well-behaved case: a clean baseline, one test config, a suite that passes. The obvious
next question is what happens on a repository that is *not* like that.

deepseek-harness has **16 to 18 failing tests on every run, before anyone changes anything**. It has
three separate Vitest configurations (unit, snapshot, e2e). It uses pnpm, whose `--` argument semantics
are inverted relative to yarn's. It was chosen because it breaks assumptions, and it did.

## The result

Five merges, selected in advance, executed in DiffCI's sandbox with both the full and selected runs
timed:

| PR | Selection | Runtime selection | Full suite | Selected suite | Job-level net reduction |
|---:|---:|---|---:|---:|---:|
| #2760 | 1 of ~864 files (0.1%) | `HONORED_EXACTLY` | 721.5s | 20.1s | **89.5%** |
| #2808 | 4 files (0.4%) | `HONORED_EXACTLY` | 480.9s | 20.0s | **89.1%** |
| #1373 | 6 files (0.6%) | `HONORED_EXACTLY` | 481.5s | 40.1s | **85.0%** |
| #2814 | 60 files (5.8%) | `HONORED_WITH_FRAMEWORK_EXPANSION` | 722.7s | 100.3s | **79.5%** |
| #2844 | 254 files (24.8%) | **`IGNORED_OR_BROADENED`** | 482.4s | — | **withheld** |

Test-stage reduction on the four eligible merges: **83.5% – 94.3%** net. Job-level: **79.5% – 89.5%**.
DiffCI's own analysis overhead (11.7–21.4s) is subtracted from every one of those figures before the net
is reported.

Note how different this looks from cal.com — **79.5–89.5% here versus 44.2% there**, with comparable
selection quality. The whole difference is install cost: deepseek-harness installs in 23–39 seconds
against a 480–723 second test suite, while cal.com's install and test stages are each about 320 seconds.
Two real repositories, the same tool, a 40-point spread in the number that ends up on an invoice. This
is the entire argument for measuring your repository instead of quoting you an industry average.

## The merge that was not counted

**#2844 selected 254 files across three test families — unit, snapshot, and e2e. The execution harness
could only run one of them.** A single `pnpm test` loads the root Vitest config; the snapshot and e2e
configs are separate files that invocation never reads. Exactly 173 files executed: the unit-family
count, exactly.

So DiffCI's selection was not honored, and the runtime invariant said so. The economics and recall for
#2844 are **withheld** — not estimated, not narrowed to the unit family after the fact, not quietly
dropped from the denominator.

It would have been easy to report "4 of 4 merges show 83–94% savings" and never mention the fifth. The
distinction between *four of five, and here is the fifth* and *four of four* is the distinction between
a measurement and a brochure.

## The regression check, and why the baseline mattered

The safety test is the same as elsewhere: revert the merge's own change in one source file, run both the
full and the selected suite, and check whether the selected run misses a failure the full run catches.

**3 of 3 measurable mutation cases were caught, with correct attribution. Two cases were unmeasurable —
one had no valid mutation target, one was unobservable because of the family-scope limitation above — and
both were excluded from the recall denominator rather than counted as passes.**

Getting that right required fixing the recall computation itself. The original version checked whether
the mutated run had any failures at all. On this repository, with 16–18 tests failing on every clean run,
that check returns "regression caught!" for every mutation, including ones that changed nothing. It is a
false positive that never fires on a clean repository — cal.com's baseline had zero failures, which is
exactly why the bug survived that far.

The fix computes recall as a **diff against the baseline failure set**: the same tests failing is not a
catch; a new test failing is. The methodology is more correct everywhere as a result, not just here.

## Four defects this repository found

All four were found by the mission's own verification discipline, fixed, covered by regression tests, and
deployed before any result was trusted:

1. **A container-name length bug** that stalled execution silently and forever, because the sandbox
   container identifier bounded the run id but not the repository slug. Found by running a cal.com
   control probe alongside the stalled deepseek run — the control advanced normally, which is what
   localized the bug to the repository name.
2. **A mutation-targeting bug** where the pathspec excluded test files but not documentation and i18n
   files, letting an unrelated file outrank the real source change alphabetically.
3. **A second mutation-targeting bug** where a nested workspace `package.json` could be mutated instead
   of source, which off-targeted the first canary run onto dependency metadata and produced 16 unrelated
   failures. The bad canary run is preserved as evidence rather than deleted.
4. **The baseline-relative recall bug** described above.

Zero of these produced a misleading published result, because each was caught before the run it would
have corrupted was trusted. That is the actual claim being made in this section: not that the harness was
correct on the first attempt, but that it was designed so its errors surfaced as visible contradictions
rather than as plausible numbers.

## What this establishes, and what it does not

**Does:** DiffCI's selection quality holds on a repository with a dirty baseline, multiple test families
and a different package manager. The runtime invariant caught a genuinely novel failure mode that never
arose on cal.com — which is the point of having an invariant rather than an assumption. The abstention
behavior (`UNMEASURABLE`, withheld economics) works on real data.

**Does not:** establish a repository-wide savings figure for deepseek-harness, or any production result —
nothing was skipped in its real CI. The modeled universe is explicitly `PARTIAL`: unit tests are modeled
and executed, snapshot tests are executable but unselected, e2e is excluded because it is credential-gated.
Five merges is five merges.

## Source reports

- [`../../research/2026-08-25-deepseek-execution-validation/`](../../research/2026-08-25-deepseek-execution-validation/) —
  19 sequential reports plus raw per-execution records.
- Report 07 — per-merge execution and economics · Report 08 — mutation recall · Report 09 — aggregate and
  the cal.com comparison · Reports 11–12 — the corrections, family-scope reclassification, and false-green
  analysis · Reports 15–19 — the differential baseline safety gate and its live proofs.
- Report 11 amends Report 09's own summary where it was too generous. The amendment is at the top of the
  earlier report, not a silent edit.
