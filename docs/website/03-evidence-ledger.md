# Evidence ledger

Every number that appears anywhere in the website drafts, with its source and its evidence level. **A
claim with no row here does not ship.** If a figure is edited in the copy, it is edited here first.

## Evidence levels

Per the project's savings-evidence model:

| Level | Means | Allowed on the site as |
|---|---|---|
| **MEASURED** | A clock produced this number in a real execution | "measured", "took", "cost" |
| **ESTIMATED** | Inferred from a cost model, not executed | "estimated avoidable", never "saved" |
| **UNKNOWN** | Evidence insufficient; DiffCI abstains | Stated as not measured |

A separate axis applies to savings specifically: **Potential** (static selection against a measured full
workload — shadow dashboard only), **Validated** (the selected workload was actually executed and
measured — may be stated as a savings claim), **Billable** (validated, under accounting rules — the only
level that may produce an invoice). The case-study savings figures are **Validated**; the shadow-pilot
report figures are **Potential**.

---

## cal.com

| Claim | Value | Level | Source |
|---|---|---|---|
| Test-stage net reduction, 5 predeclared merges | 86.0% – 91.6% | MEASURED / Validated | [`13-five-merge-batch-results.md`](../research/2026-08-24-calcom-execution-observability/13-five-merge-batch-results.md) |
| Complete-job net reduction (install+pretest+test) | 44.2% net / 45.7% gross | MEASURED / Validated | [`11-frozen-identity-and-complete-job-savings.md`](../research/2026-08-24-calcom-execution-observability/11-frozen-identity-and-complete-job-savings.md) §2 |
| Test-stage reduction on PR #29940 | 90.6% net / 93.8% gross | MEASURED | Report 10, restated in Report 11 §2 |
| Stage timings: install 319.7s, pretest 17.1s, test 320.9s → 20.0s | as stated | MEASURED | Report 11 §2 |
| Full-suite duration range | 204.6s – 462.3s | MEASURED | Report 13 |
| Selected-suite duration range ("the floor") | 20.1s – 20.7s | MEASURED | Report 13 |
| Selected/total test files | 1–5 of ~249–250 | MEASURED | Report 13 |
| Runtime selection honored exactly | 8 of 8 executions | MEASURED | Report 13, aggregate section |
| Mutation recall | 3 of 3 unique measurable cases; 5 of 8 executions measurable | MEASURED | Reports 04, 13; aggregate in [`09-aggregate-and-comparison.md`](../research/2026-08-25-deepseek-execution-validation/09-aggregate-and-comparison.md) |
| Infrastructure failures | 0 of 8 | MEASURED | Report 13 |
| Analysis overhead | ~10–11s | MEASURED | Report 09 comparison table |
| Merge-selection rule was predeclared | yes, before costs were known | Process fact | Report 11 §3 |
| Modeled universe | PARTIAL (no E2E in cal.com CI) | Stated limitation | Report 09 comparison table |

## deepseek-ai/deepseek-harness

| Claim | Value | Level | Source |
|---|---|---|---|
| Test-stage net reduction, 4 eligible merges | 83.5% – 94.3% | MEASURED / Validated | [`07-execution-and-economics.md`](../research/2026-08-25-deepseek-execution-validation/07-execution-and-economics.md) |
| Complete-job net reduction | 79.5% – 89.5% | MEASURED / Validated | Report 07, job-level table |
| Per-merge full/selected timings | 480.9s–722.7s full; 20.0s–140.3s selected | MEASURED | Report 07 |
| Selection percentages | 0.1% – 24.8% | MEASURED | Report 07 |
| Runtime selection outcome | 3 `HONORED_EXACTLY`, 1 framework-expansion, 1 `IGNORED_OR_BROADENED` | MEASURED | Report 07 |
| #2844 economics and recall withheld | withheld, not estimated | Abstention (by design) | Report 07 |
| Install cost 23–39s vs test 480–723s | as stated | MEASURED | Report 07, timing notes |
| Mutation recall | 3 of 3 measurable; 2 correctly unmeasurable | MEASURED | [`08-mutation-recall.md`](../research/2026-08-25-deepseek-execution-validation/08-mutation-recall.md), Report 09 |
| Pre-existing baseline failures | 16–18 on every run | MEASURED | Report 09, defect 4 |
| Four harness defects found and fixed | as listed | Process fact | Report 09 |
| Analysis overhead | 11.7s – 21.4s | MEASURED | Report 07 |
| Modeled universe | PARTIAL (unit executed; snapshot unselected; e2e credential-gated) | Stated limitation | Report 09 |

## DiffCI's own repository

| Claim | Value | Level | Source |
|---|---|---|---|
| Test suite size and status | 1,940 tests / 384 suites, 0 failures | MEASURED, local run 2026-09-04 | `npm run test` on the working tree of this date — grown substantially since the 2026-08-26 figure (1,342/286); re-check before publishing, this rots fast |
| CI cost per job | **$0.0044 – $0.0116** (median duration $0.0052, mean $0.0063) | provider_estimate, **re-measured 2026-09-04** | `scripts/remeasure-own-ci-cost.ts`, 10 most recent real `check` job(s) on `main`, priced with `createCloudflareContainersStandard2CostModel()` (`src/usage/cost-model.ts`) — the real `standard-2` shape (1 vCPU / 6 GiB / 12 GB disk) `ops/github-runner/wrangler.github-runner.jsonc` actually runs, not the smaller `lite` shape. Real Cloudflare-published rate x measured job duration; not an invoice line — see the script's own output for the basis. |
| CI wall time | **126s – 325s** (median 146s, mean 176s) once warm | MEASURED, **re-measured 2026-09-04** | Same script/run as above — real job `started_at`/`completed_at` from the GitHub Actions API, not an estimate. Materially higher than the 2026-08-21 figure (~1m3s): the test suite has grown roughly 4x in the same window (286 → 381 suites). |
| GitHub Actions minutes billed | zero | MEASURED as of 2026-08-21 | `CURRENT_STATE.md` §5 |
| Six runner bugs, including the `HOSTNAME=cloudchamber` collision | as listed | Process fact | `CURRENT_STATE.md` §5 |
| Unquoted-glob test-discovery bug; 579 → 734 tests | as stated | MEASURED, 2026-08-22 | [`2026-08-22-preflight-p1-test-discovery-bug.md`](../research/2026-08-22-preflight-p1-test-discovery-bug.md) |
| Preflight prevention recall | 0.696 (16 TP / 7 FN / 1 not evaluable) | MEASURED | [`2026-08-22-preflight-p1-replay-results.md`](../research/2026-08-22-preflight-p1-replay-results.md) |
| All 9 unit-test failures in that dataset were misses | as stated | MEASURED | same report |
| First replay scored 0.958 and was wrong | as stated | Process fact | same report, methodology section |

## Product-behavior claims (no number, still need a source)

| Claim | Source |
|---|---|
| Shadow mode is read-only end to end — never writes, comments, labels, or checks out for writing | [`CURRENT_STATE.md`](../CURRENT_STATE.md) §9 |
| Shadow App permissions are read-only: metadata, contents, actions, checks, pull requests | `CURRENT_STATE.md` §5; [`github-app-registration.md`](../github-app-registration.md) |
| Mandatory fallback to full CI on lockfile / workflow / root-config changes | `src/planner/`, exercised in both case studies' fallback observations |
| Dependency graph is TypeScript-compiler-backed, reachability-based, confidence-scored | [`README.md`](../../README.md); `src/repo/` |
| A failed git analysis returns an explicit error, never a silently-empty affected set | `CURRENT_STATE.md` §1 |
| The estimator refuses to produce savings for non-test stages | `src/usage/economics-estimator.ts`; [`shadow-pilot-runbook.md`](../shadow-pilot-runbook.md) |
| Nothing has ever been skipped, cancelled, or blocked in any real CI | `README.md`; `CURRENT_STATE.md` TL;DR |

## Claims deliberately NOT made

| Tempting claim | Why it is not on the site |
|---|---|
| "Cut your CI costs by 90%" | The 90% figure is test-stage on one repository; the job-level figure on the same repository is 44.2% |
| "Trusted by cal.com / DeepSeek" | Neither project uses DiffCI or has been contacted. Naming them as users would be false |
| "Zero missed failures" | The measured denominator is 6 unique mutation cases across two repositories |
| Any single headline savings percentage | The two validated repositories differ by ~40 points at job level, entirely due to install cost |
| "N repositories in the pilot" as traction | The cohort is thin and one enrollment was excluded as unanalysable; see [`2026-08-26-shadow-ramp-load-gate.md`](../research/2026-08-26-shadow-ramp-load-gate.md) |
| A dollar figure for anyone's savings | No repository has been billed, and no selected run has been executed for any external repository |

## Before publishing — required re-verification

1. **Re-measure the $0.004/job and CI wall-time figures.** They date from 2026-08-21 and the fleet has
   changed since.
2. **Re-run the suite immediately before launch** and update the test/suite counts, or replace them with
   a live badge rather than a hardcoded number that will rot.
3. **Re-read every linked report path** — this ledger's links must resolve from the built site, not just
   from the repository.
4. **Confirm the external-pilot language** against the cohort state on the launch date, not this one.
