# Case study — cal.com

**Status:** draft, not published. Numbers traced in [`../03-evidence-ledger.md`](../03-evidence-ledger.md).

> **cal.com is not a DiffCI customer.** It is a public open-source repository with public CI. Everything
> below was produced by analyzing its public source and replaying its own test suite in DiffCI's sandbox.
> cal.com has not installed DiffCI, has not been contacted about it, and has not endorsed anything here.
> No change was ever proposed to, or made in, cal.com's real CI.

---

## The short version

Across six real merges from cal.com's history — five of them selected by a rule written down *before*
anyone looked at what they would cost — DiffCI selected between 1 and 5 test files out of ~250, and the
selected runs were then actually executed and timed against full-suite runs of the same commit.

| | Result |
|---|---|
| Test-stage reduction, net of DiffCI's own analysis cost | **86.0% – 91.6%** across the 5 predeclared merges |
| Complete-job reduction (install + pretest + test) | **44.2%** net on the merge where all three stages were timed |
| Runtime selection honored exactly | **8 of 8** executions |
| Mutation recall | **3 of 3** unique measurable cases caught, 0 missed |
| Infrastructure failures | **0 of 8** |

## Why there are two different reduction numbers

This is the most important paragraph in the case study, and it argues *against* the bigger number.

cal.com's test stage took 204–462 seconds to run in full. Its `yarn install` took **319.7 seconds**, and
`prisma generate` another 17.1. Install and pretest are paid identically whether you run 250 test files
or one — they do not shrink when the test selection does.

| Stage | Full path | Selected path |
|---|---:|---:|
| install | 319.7s | 319.7s |
| pretest (`prisma generate`) | 17.1s | 17.1s |
| test | 320.9s | 20.0s |
| **Job-equivalent total** | **657.7s** | **356.9s** |

Measured against the test stage alone: **90.6% net reduction**. Measured against the whole job:
**44.2% net**. Both are true. Both are published. The site leads with 44.2%.

Which one applies to a given repository depends on whether install is cached and shared across a job
matrix — which is exactly how cal.com's own workflows are structured, and why the test-stage figure is
not merely a flattering artifact. But we are not going to assume that about anyone's pipeline, so the
smaller number is the headline.

## The five merges

Selected by a predeclared rule, from a 30-merge blind baseline manifest: every merge marked
`SAFE_TO_PROPOSE` with at least one changed source file (24 of 30 qualified), sorted ascending by
DiffCI's own selected-set size, and sampled evenly by rank position. The rule was written before the
costs were known and the resulting set was not adjusted afterwards.

| PR | Selected / total | Full test stage | Selected test stage | Net saved | Reduction |
|---:|---:|---:|---:|---:|---:|
| #29529 | 1 / 250 | 287.8s | 20.7s | 255.8s | 88.9% |
| #29819 | 1 / 250 | 461.4s | 20.1s | 421.6s | 91.4% |
| #29583 | 2 / 250 | 300.9s | 20.1s | 266.1s | 88.4% |
| #29541 | 3 / 249 | 462.3s | 20.1s | 423.6s | 91.6% |
| #28567 | 5 / 249 | 204.6s | 20.6s | 176.1s | 86.0% |

Two things are visible here that a marketing chart would smooth over:

- **The full-suite time swings from 204.6s to 462.3s for the same suite.** That is container scheduling
  variance, not a per-merge effect, and it is the reason the reduction percentage varies more than the
  underlying selection quality does.
- **The selected run has a floor: 20.1–20.7s, every time.** A run of one test file costs almost the same
  as a run of five, because bootstrap dominates. That floor is precisely why DiffCI refuses to bill from
  a linear estimate — a model that assumes uniform per-test cost would predict a 1-of-250 selection cost
  near zero, and it would be wrong by twenty seconds every single run.

## Did the selection actually get executed?

Selecting tests is easy. Getting a test runner to honor the selection — and *proving* it did — is where
this kind of claim usually falls apart.

Every execution recorded a runtime invariant comparing the files DiffCI selected against the files the
runner actually ran: `HONORED_EXACTLY`, `HONORED_WITH_FRAMEWORK_EXPANSION`, or `IGNORED_OR_BROADENED`.

**8 of 8 cal.com executions came back `HONORED_EXACTLY`**, across 6 different merges, changesets from 1
to 11 files, and selected sets from 1 to 5 tests. Not "we passed a filter and assumed"; the executed file
count matched the selected file count exactly.

This invariant exists because an earlier run of this work found a real bug where an extra `--` in the
test command silently swallowed the file filter and ran the whole suite while reporting success. The
invariant caught it. That is the reason to trust the eight.

## Would it have caught a real regression?

For each merge, the merge's own change was reverted in a single source file (never a test file), and both
the full suite and the selected suite were run against the mutated tree. If the full suite catches a
failure the selected suite does not, that is a miss — the thing that actually matters.

| PR | Measurable? | Outcome |
|---:|---|---|
| #29583 | yes | Caught. `handleCancelBooking.test.ts` — the exact test matching the PR's subject. Selected suite caught it identically to the full suite. |
| #28567 | yes | Caught. 5 tests in `EditLocationDialog.test.tsx`, all matching the reverted rename. Selected suite caught all 5. |
| #29529 | no | Full suite caught nothing either — the change had no test coverage anywhere. A coverage gap in the repository, not a DiffCI miss. |
| #29819 | no | Mutation target was a *generated* metadata file. No behavioral surface to break. |
| #29541 | no | The PR was a genuine no-op refactor. Reverting it changes no observable behavior, so no suite could catch it. |

**2 of 5 mutations were measurable; both were caught, by both suites, with exact attribution.** The
other three are reported as `recallMeasurable: false` rather than scored as passes.

Counting the sixth merge — PR #29940, the one executed repeatedly for variance sampling — cal.com's full
record is **3 unique measurable mutation cases, 3 caught, 0 missed**, across 5 of 8 executions where
recall was measurable at all. Repeated executions of the same merge are counted once, not eight times.

The temptation here is obvious: 5 of 5 mutations "survived without a miss" reads better than "2 of 5 were
measurable." The harness has an explicit anti-vacuity rule preventing exactly that framing, because a
mutation that breaks nothing proves nothing about recall in either direction.

## What this does not establish

- **Not a cal.com-wide savings figure.** Six merges is six merges. It is not "cal.com's CI in general,"
  and the site does not say it is.
- **Not a production result.** Nothing was skipped in cal.com's real CI. Both paths were executed in
  DiffCI's own sandbox so that both could be timed.
- **Not a general safety guarantee.** Three measurable mutation cases is a small denominator, stated as
  such.
- **E2E is out of scope.** cal.com does not run E2E in the CI configuration modeled here, so the
  modeled universe is explicitly `PARTIAL`.

## Source reports

- [`../../research/2026-08-24-calcom-execution-observability/`](../../research/2026-08-24-calcom-execution-observability/) —
  13 sequential reports, plus the raw per-execution JSON records, preserved and never overwritten.
- Report 10 — default-isolation economics · Report 11 — complete-job savings and the predeclared merge
  selection · Report 12 — median/variance sampling · Report 13 — the five-merge batch results.
- The reports include the failures: an argument-forwarding bug, an anomalous corrected run, and a
  project-qualified filter that behaved differently than expected. They were not removed after the fact.
