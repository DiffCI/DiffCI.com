# Evaluating DiffCI for an open-source repository

Start with a local [`observe --no-send` run](../README.md#diffci), then use the
[dedicated, non-blocking Action job](../README.md#observe-in-github-actions) if the report is useful.
Keep existing required checks and full test runs in place during observation. The report should
show the proposed test selection, evidence, fallback reasons, and whether a runnable selected
command is available. `REFUSED` and `ERROR` are not successful analyses.

## Evidence levels

| Evidence | What it can support | What it cannot establish |
| --- | --- | --- |
| One observation report | Whether DiffCI can analyze this revision and propose a selection | Correctness of omitted tests or runtime savings |
| Repeated shadow observations | Frequency of selections, fallbacks, unsupported cases, and report stability | Realized CI savings while full CI still runs |
| Paired full/selected execution | Runtime difference for the measured environment and commands, including analysis overhead | Production savings or safety across future changes |
| Prospective comparison with actual CI outcomes | Stronger evidence about selection behavior for observed revisions | Universal safety outside the observed workload |

For a local paired run, follow the [self-serve runtime pilot](npm-adoption.md#self-serve-runtime-pilot).
Record the repository and revision, full and selected commands, runner, cache state, exit statuses,
analysis time, and both runtimes. Repeat comparisons with controlled cache conditions. Investigate
every case where the full run finds a failure that the selected run misses. Report the count of
eligible analyses alongside fallback and refusal counts; selection percentages without those
denominators can be misleading.

## Existing public work

- [Historical validation](evidence/growth-history-01/README.md) and
  [release 0.1.4 qualification](evidence/release-0.1.4/README.md) describe prior analysis and a
  selection defect that was corrected. Revalidate observations made with affected versions.
- The [controlled Cal.com comparison](research/2026-08-24-calcom-execution-observability/11-frozen-identity-and-complete-job-savings.md)
  measures one job-equivalent workload. It is not Cal.com's production savings or a prediction for
  another repository.
- The [deepseek-harness execution validation](research/2026-08-25-deepseek-execution-validation/07-execution-and-economics.md)
  records paired full and selected execution on a second repository. Count only the runs where both
  arms executed and the selection was honored; withheld or broadened cases are diagnostic evidence,
  not savings evidence.
- [Current research state](CURRENT_STATE.md) and the
  [Stage 2 report](research/2026-08-21-stage2-final-report.md) describe prospective shadow work and
  its remaining limits.

## Corrected experiment narrative

Use this as the canonical public summary when writing directory copy, maintainer packets, posts, or
case-study drafts:

DiffCI has measured paired full and selected execution on Cal.com and deepseek-harness in controlled
sandbox runs. Those results show that DiffCI can identify smaller test workloads for some real changes
and that the measured runtime effect depends on the whole job, not only the test command. Cal.com's
reported 44.2% net reduction is job-equivalent install, pretest, and test time for one controlled
comparison; its test-stage reductions are larger, but they are not production CI savings. Deepseek's
eligible measured runs are a second controlled execution study, not evidence that the project uses
DiffCI.

The public story must also carry the corrections. Observations affected by the pre-0.1.4 missing
test-import-edge defect need revalidation before they are used as opportunity evidence. Ky's earlier
smaller selection was withdrawn on that basis. Full-validation fallbacks, refused analyses, unrouted
commands, failed command pairs, checkout-provenance failures, and cache-ambiguous timings remain in the
denominator. Selection counts by themselves do not prove runtime savings, and shadow observations do
not prove realized savings while the repository still runs full CI.

For maintainers, publish three facts separately:

| Fact | May say | Do not say |
| --- | --- | --- |
| Observation | DiffCI observed a revision, selected tests or fell back, and wrote reasons. | The omitted tests were proven safe. |
| Paired runtime | A full command and selected command were executed and timed in one environment. | The repository will save that amount in production CI. |
| Production savings | Existing CI behavior changed and the selected path was actually used and measured. | Anything, unless that production measurement exists. |

For ecosystem adoption, publish pilot summaries only with the participating maintainer's consent.
Separate observed selections, measured runtime differences, and proven production savings in every
summary. Report negative and unsupported results as well as successful cases.
