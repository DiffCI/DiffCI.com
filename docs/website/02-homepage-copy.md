# Homepage copy

**Status:** draft, not published. Every number below has a row in
[`03-evidence-ledger.md`](03-evidence-ledger.md). Sections are in page order; `[...]` marks a decision
that is still open.

---

## Hero

> # Find out what your CI is wasting. Without changing your CI.
>
> DiffCI watches your repository's real CI runs, works out which tests each change could actually have
> affected, and reports how much compute was avoidable — in hindsight, against what your CI really did.
>
> It has no permission to skip, cancel, or modify anything. That is not a setting. It is the only mode
> that exists.
>
> **[ Install the read-only App ]**  ·  [Read the evidence](#evidence)

*Why no percentage in the hero:* the honest number is repository-specific — the same selection quality
produced ~44% and ~85% job-level reduction on two different real repositories. A hero number would have
to be an average of two things that aren't alike.

---

## The problem

> A twelve-line change to one package re-runs four thousand tests in ninety other packages.
>
> Everyone knows this is happening. Almost nobody knows what it costs them, because measuring it means
> either trusting a tool to start skipping things, or running an experiment nobody has time to design.
>
> DiffCI is the measurement, delivered before the risk.

---

## How it works

> **1 · Observe** — A read-only GitHub App sees pushes and completed workflow runs. Metadata, contents,
> Actions, checks. Read-only, all four.
>
> **2 · Analyze** — For each change, DiffCI builds a real TypeScript compiler-backed dependency graph,
> computes what is reachable from the changed files, and produces a confidence-scored plan: which tests
> a safe system would have run. Changes it cannot reason about — lockfiles, workflow files, root config —
> force a mandatory fallback to "run everything." That is the default, not the exception path.
>
> **3 · Reconcile** — When your CI finishes, DiffCI reads the real outcome and timings and asks the only
> question that matters in hindsight: *would that plan have missed a failure your CI actually caught?*
>
> **4 · Report** — Runs observed, compute consumed, compute avoidable, missed failures, and — explicitly —
> what could not be measured.

---

## The report (sample)

> ```
> Last 7 days · your-org/your-repo
>
>   CI runs observed                    186
>   Runner-hours consumed              94.2   MEASURED
>   Runner-hours potentially avoidable 31.7   ESTIMATED
>   Observed missed failures              0   MEASURED
>   Selected-run execution         not measured
> ```
>
> Three labels, and they mean exactly what they say. **MEASURED** is a number a clock produced.
> **ESTIMATED** is an inference from a cost model whose weaknesses we will tell you about.
> **UNKNOWN** is where a lesser tool would have guessed.
>
> DiffCI will not turn an ESTIMATED figure into an invoice. Ever. If it eventually charges for anything,
> it charges against savings that were executed and timed.

*[Open: is the sample report shown with illustrative numbers, or held until a real external 7-day report
exists? Illustrative numbers must be visibly labeled as such.]*

---

## Evidence {#evidence}

> Nothing on this page comes from a demo. Every figure below was produced by executing real test suites
> from real repositories on real infrastructure, with the full run and the selected run both timed.
>
> ### cal.com — 5 predeclared merges, plus one measured six ways
>
> | | |
> |---|---|
> | Test-stage reduction | **86.0% – 91.6%** net, across 5 merges |
> | Complete-job reduction | **44.2%** net, on the merge where install and pretest were also timed |
> | Selection honored exactly | **8 of 8** executions |
> | Mutation recall | **3 of 3** unique measurable cases caught |
>
> The two reduction figures are the same saving measured against two different denominators. cal.com's
> install costs about as much as its entire test suite, so cutting the test stage by 91% cuts the job by
> 44%. We publish both, and lead with the smaller one.
>
> [Read the cal.com case study](case-studies/01-calcom.md)
>
> ### deepseek-ai/deepseek-harness — the repository that was allowed to be messy
>
> | | |
> |---|---|
> | Test-stage reduction | **83.5% – 94.3%** net, 4 of 5 merges |
> | Complete-job reduction | **79.5% – 89.5%** net |
> | Mutation recall | **3 of 3** measurable cases caught |
> | Selection *not* honored | **1 of 5** — reported as a limitation, not scored as a win |
>
> This repository has 16–18 failing tests on every run before anyone changes anything. A naive safety
> check reads that as "the selected run caught the regression" and is wrong every time. DiffCI's recall
> is computed as a diff against the baseline, which is how this repository's flaws became evidence
> rather than noise.
>
> [Read the deepseek-harness case study](case-studies/02-deepseek-harness.md)
>
> ### DiffCI's own CI
>
> DiffCI's test suite — **1,960 tests across 389 suites, currently green** — does not run on
> GitHub-hosted runners. It runs on ephemeral Cloudflare containers at **$0.0048–$0.0127 per job**
> (median $0.0053), **2–6 minutes per run**, with zero GitHub Actions minutes billed. We built our own
> runner fleet because we needed the timing data to be ours.
>
> [Read how](case-studies/03-diffci-own-ci.md)

---

## What we won't tell you

> This section is here on purpose, and it is not going to be moved to the footer.
>
> - **Nobody's CI has ever been made faster by DiffCI.** Nothing has ever been skipped in a production
>   pipeline. The savings above were measured by executing both paths in our own sandbox.
> - **There are no customers.** cal.com, deepseek-harness and the unjs projects are public repositories
>   analyzed from public data. None of them use DiffCI. None of them have endorsed it.
> - **Our failure prediction is not good yet.** Replayed against 24 of our own historical CI failures,
>   the preflight checks would have caught **16 of 23** evaluable ones — 0.696. Every one it caught was a
>   typecheck or configuration failure. **Every unit-test failure in that dataset was a miss.**
> - **There is no external pilot yet.** At the time of writing, no repository outside our own two has
>   installed the App. An earlier internal shadow cohort of public repositories was small, and one
>   repository in it turned out to be unanalysable and was excluded rather than quietly retried. None of
>   that is traction, and we are not going to describe it as such.
> - **Small selections make our estimator optimistic.** A run selecting zero of forty tests still pays
>   the suite's startup cost, and the estimator does not model that. It is being calibrated per
>   repository from real measurement, not patched with a guessed constant.

---

## For the pilot

> **What you give:** read-only access to one repository, for seven days.
>
> **What you get:** a report of what your CI ran, what was avoidable, and whether any change DiffCI would
> have de-prioritized turned out to break something.
>
> **What it costs:** nothing. There is no paid tier to upgrade to yet. The open question we are paying to
> answer is whether the report is worth having.
>
> **What we do with your data:** analysis of your repository's public CI metadata and its source at the
> commits we analyze. No writes, no comments, no branch checkouts. *[Open: full data-handling statement
> needed before launch — retention window, what lands in R2, deletion on uninstall.]*
>
> **[ Start a 7-day shadow pilot ]**

---

## Footer

> DiffCI — deterministic, change-aware CI planning.
> [GitHub](https://github.com/adityankale190895/DiffCI.com) · Research reports · Contact
>
> *[Open: entity name, jurisdiction, and contact address. The project currently ships under a personal
> GitHub account.]*

---

## Open decisions blocking a build

1. Sample-report numbers: illustrative-and-labeled, or wait for a real external report.
2. Data-handling statement — required before any external developer is asked to install.
3. Legal entity / contact identity in the footer.
4. Whether the pilot CTA points at the existing Shadow App install URL or at a form that queues
   repositories for screening. The screening step is real (`npm run shadow:screen`) and rejects
   repositories that cannot be analyzed — sending an ineligible repository straight to install would
   waste the visitor's time and a container launch.
