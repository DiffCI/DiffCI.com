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
- [Current research state](CURRENT_STATE.md) and the
  [Stage 2 report](research/2026-08-21-stage2-final-report.md) describe prospective shadow work and
  its remaining limits.

For ecosystem adoption, publish pilot summaries only with the participating maintainer's consent.
Separate observed selections, measured runtime differences, and proven production savings in every
summary. Report negative and unsupported results as well as successful cases.
