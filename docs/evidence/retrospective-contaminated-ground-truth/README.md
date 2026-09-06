# Retrospective dataset: CONTAMINATED_WORKFLOW_IDENTITY ground-truth rows

**What this is.** Measurement-integrity repair step 2 (2026-09-05) labelled every pre-fix ground-truth
row that had been reconciled against the wrong workflow, or against a run that never executed,
`CONTAMINATED_WORKFLOW_IDENTITY`: kept in `shadow_ground_truth` unchanged, never counted by any report,
never re-admitted. The founder reserved a *separate* retrospective dataset for "if ever needed". This is
it, built 2026-09-06 by `scripts/retrospective-contaminated-ground-truth.ts` from
`src/shadow/retrospective-evidence.ts` (pure, tested).

**What it is not.** It admits nothing. No row here changes `evidence_validity`, feeds a report, a
dashboard, stage economics, or a savings figure. It says, for each contaminated row, *which run would
have been the evidence under today's identity rule and whether that run executed* - not what the
evidence would have shown. Failure counts and preservation cannot be re-derived from run metadata.

**Production writes by the build: zero.** Every D1 statement is a `SELECT`, every GitHub call a `GET`.

## Rule

For each contaminated row (joined to its prediction): list every GitHub Actions run for the row's head
SHA; the retrospective evidence run is the **earliest-created run of an evidence workflow that
executed** (`success` or `failure`) - the first genuine execution, which is what a live reconcile would
have seen first. Precedence is stated two ways:

| Column | Rule | Comparable to |
|---|---|---|
| `predictionPrecededRetroEvidence` | prediction created before the evidence run **completed** (GitHub `updated_at`) | the live column `prediction_preceded_ground_truth` (`src/shadow/event-identity.ts`) |
| `predictionPrecededRetroEvidenceStart` | prediction created before the evidence run was even **created** | stricter; a poll-detected prediction made after the push fails it |

## Columns (`rows.csv`; `rows.json` adds `runsForHead`, the whole field the choice was made from)

`logicalEventKey`, `headSha`, `predictionCreatedAt`, `planMode`, `testsSelectedDiffci`, `testsTotalFull`,
`recordedRunId` / `recordedRunPath` / `recordedConclusion` (what the row was reconciled against),
`contaminationReason` (`WRONG_WORKFLOW` | `NOT_EXECUTED` | `WRONG_WORKFLOW_AND_NOT_EXECUTED` |
`NO_RUN_RECORDED` | `UNRESOLVABLE`), `evidenceRunsForHead`, `retroVerdict` (`EVIDENCE_EXECUTED` |
`EVIDENCE_NOT_EXECUTED` | `NO_EVIDENCE_RUN` | `UNRESOLVABLE`), `retroEvidenceRunId`,
`retroEvidenceConclusion`, `retroEvidenceCreatedAt`, `retroEvidenceCompletedAt`, and the two precedence
columns above. `summary.json` carries the tallies and provenance (built-at, evidence workflows, GitHub
calls, `productionWrites: 0`).

## Rebuild

```bash
npx tsx scripts/retrospective-contaminated-ground-truth.ts --repository OWNER/REPO
```

Output goes to `<owner>--<repo>/` beside this file. Rebuilding overwrites that directory; the previous
build stays in git history.
