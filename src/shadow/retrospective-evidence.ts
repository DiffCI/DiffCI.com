/**
 * Retrospective evidence for CONTAMINATED ground-truth rows (2026-09-06).
 *
 * Measurement-integrity repair step 2 labelled every pre-fix ground-truth row that had been reconciled
 * against the wrong workflow, or against a run that never executed, CONTAMINATED_WORKFLOW_IDENTITY - kept
 * immutable, never counted. The founder asked for the retrospective view as a SEPARATE dataset: for each
 * such row, which run of the repository's evidence workflow (if any) would have been the evidence under
 * today's identity rule, whether it executed, and whether the prediction preceded it.
 *
 * This module is the pure classification; the script writes files under docs/evidence. Nothing here
 * admits anything: a retrospective row is a labelled observation about history, never read by a report,
 * never written back to shadow_ground_truth. Failure counts and preservation cannot be re-derived from
 * run metadata - a retrospective row says what the evidence WOULD HAVE BEEN, not what it would have shown.
 */

export interface GitHubRunSummary {
  id: number;
  path: string;
  conclusion: string | null;
  status: string;
  createdAt: string;
  runStartedAt?: string;
  updatedAt?: string;
  event?: string;
  runAttempt?: number;
}

export interface ContaminatedRowInput {
  logicalEventKey: string;
  headSha: string;
  /** The run the row was reconciled against, as recorded (and its path as GitHub reported it at labelling). */
  recordedRunId: string | null;
  recordedRunPath: string | null;
  recordedConclusion: string | null;
  predictionCreatedAt: string;
  planMode: string;
  testsSelectedDiffci: number;
  testsTotalFull: number;
}

export type ContaminationReason = "WRONG_WORKFLOW" | "NOT_EXECUTED" | "WRONG_WORKFLOW_AND_NOT_EXECUTED" | "NO_RUN_RECORDED" | "UNRESOLVABLE";
export type RetrospectiveVerdict = "EVIDENCE_EXECUTED" | "EVIDENCE_NOT_EXECUTED" | "NO_EVIDENCE_RUN" | "UNRESOLVABLE";

export interface RetrospectiveRow {
  logicalEventKey: string;
  headSha: string;
  predictionCreatedAt: string;
  planMode: string;
  testsSelectedDiffci: number;
  testsTotalFull: number;
  recordedRunId: string | null;
  recordedRunPath: string | null;
  recordedConclusion: string | null;
  contaminationReason: ContaminationReason;
  /** Every run GitHub lists for this head, by path and conclusion - the whole field the choice was made from. */
  runsForHead: Array<{ id: number; path: string; conclusion: string | null; status: string; createdAt: string }>;
  evidenceRunsForHead: number;
  retroVerdict: RetrospectiveVerdict;
  retroEvidenceRunId: number | null;
  retroEvidenceConclusion: string | null;
  retroEvidenceCreatedAt: string | null;
  /** GitHub's updated_at of the chosen run - its completion time for a completed run. */
  retroEvidenceCompletedAt: string | null;
  /** The live pipeline's rule (event-identity.ts predictionPrecededGroundTruth): prediction created before
   * the evidence run COMPLETED. true / false when a retrospective evidence run exists; null otherwise. */
  predictionPrecededRetroEvidence: boolean | null;
  /** Stricter: prediction created before the evidence run was even CREATED. A poll-detected prediction
   * made after the push can pass the completion rule and fail this one. */
  predictionPrecededRetroEvidenceStart: boolean | null;
}

export function isExecutedConclusion(conclusion: string | null | undefined): boolean {
  return conclusion === "success" || conclusion === "failure";
}

export function contaminationReason(input: ContaminatedRowInput, evidenceWorkflowPaths: readonly string[]): ContaminationReason {
  if (!input.recordedRunId) return "NO_RUN_RECORDED";
  if (!input.recordedRunPath) return "UNRESOLVABLE";
  const wrongWorkflow = !evidenceWorkflowPaths.includes(input.recordedRunPath);
  const notExecuted = !isExecutedConclusion(input.recordedConclusion);
  if (wrongWorkflow && notExecuted) return "WRONG_WORKFLOW_AND_NOT_EXECUTED";
  if (wrongWorkflow) return "WRONG_WORKFLOW";
  if (notExecuted) return "NOT_EXECUTED";
  // Labelled contaminated yet identity and execution both hold by today's rule: keep it visible rather
  // than silently re-admitting it - the label was applied by a person-reviewed backfill.
  return "UNRESOLVABLE";
}

/**
 * The evidence run under today's rule: the EARLIEST-created run of an evidence workflow for this head
 * that actually executed (the first genuine execution, which is what a live reconcile would have seen
 * first). If evidence-workflow runs exist but none executed, the verdict says so; if none exist at all,
 * that too.
 */
export function classifyRetrospective(
  input: ContaminatedRowInput,
  evidenceWorkflowPaths: readonly string[],
  runsForHead: readonly GitHubRunSummary[] | undefined,
): RetrospectiveRow {
  const base = {
    logicalEventKey: input.logicalEventKey,
    headSha: input.headSha,
    predictionCreatedAt: input.predictionCreatedAt,
    planMode: input.planMode,
    testsSelectedDiffci: input.testsSelectedDiffci,
    testsTotalFull: input.testsTotalFull,
    recordedRunId: input.recordedRunId,
    recordedRunPath: input.recordedRunPath,
    recordedConclusion: input.recordedConclusion,
    contaminationReason: contaminationReason(input, evidenceWorkflowPaths),
  };
  if (!runsForHead) {
    return { ...base, runsForHead: [], evidenceRunsForHead: 0, retroVerdict: "UNRESOLVABLE", retroEvidenceRunId: null, retroEvidenceConclusion: null, retroEvidenceCreatedAt: null, retroEvidenceCompletedAt: null, predictionPrecededRetroEvidence: null, predictionPrecededRetroEvidenceStart: null };
  }
  const listed = [...runsForHead].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const evidenceRuns = listed.filter((r) => evidenceWorkflowPaths.includes(r.path));
  const executed = evidenceRuns.filter((r) => isExecutedConclusion(r.conclusion));
  const chosen = executed[0];
  const summary = listed.map((r) => ({ id: r.id, path: r.path, conclusion: r.conclusion, status: r.status, createdAt: r.createdAt }));
  if (chosen) {
    return {
      ...base,
      runsForHead: summary,
      evidenceRunsForHead: evidenceRuns.length,
      retroVerdict: "EVIDENCE_EXECUTED",
      retroEvidenceRunId: chosen.id,
      retroEvidenceConclusion: chosen.conclusion,
      retroEvidenceCreatedAt: chosen.createdAt,
      retroEvidenceCompletedAt: chosen.updatedAt ?? null,
      predictionPrecededRetroEvidence: chosen.updatedAt ? Date.parse(input.predictionCreatedAt) < Date.parse(chosen.updatedAt) : null,
      predictionPrecededRetroEvidenceStart: Date.parse(input.predictionCreatedAt) < Date.parse(chosen.createdAt),
    };
  }
  return {
    ...base,
    runsForHead: summary,
    evidenceRunsForHead: evidenceRuns.length,
    retroVerdict: evidenceRuns.length > 0 ? "EVIDENCE_NOT_EXECUTED" : "NO_EVIDENCE_RUN",
    retroEvidenceRunId: null,
    retroEvidenceConclusion: null,
    retroEvidenceCreatedAt: null,
    retroEvidenceCompletedAt: null,
    predictionPrecededRetroEvidence: null,
    predictionPrecededRetroEvidenceStart: null,
  };
}

export interface RetrospectiveSummary {
  rows: number;
  byContaminationReason: Record<string, number>;
  byRetroVerdict: Record<string, number>;
  byRetroEvidenceConclusion: Record<string, number>;
  predictionPrecededRetroEvidence: { true: number; false: number; null: number };
  predictionPrecededRetroEvidenceStart: { true: number; false: number; null: number };
}

export function summarize(rows: readonly RetrospectiveRow[]): RetrospectiveSummary {
  const count = (keys: Array<string | null>) => {
    const out: Record<string, number> = {};
    for (const k of keys) out[k ?? "null"] = (out[k ?? "null"] ?? 0) + 1;
    return out;
  };
  const tally = (pick: (r: RetrospectiveRow) => boolean | null) => {
    const t = { true: 0, false: 0, null: 0 };
    for (const r of rows) {
      const v = pick(r);
      t[v === null ? "null" : v ? "true" : "false"]++;
    }
    return t;
  };
  return {
    rows: rows.length,
    byContaminationReason: count(rows.map((r) => r.contaminationReason)),
    byRetroVerdict: count(rows.map((r) => r.retroVerdict)),
    byRetroEvidenceConclusion: count(rows.map((r) => r.retroEvidenceConclusion)),
    predictionPrecededRetroEvidence: tally((r) => r.predictionPrecededRetroEvidence),
    predictionPrecededRetroEvidenceStart: tally((r) => r.predictionPrecededRetroEvidenceStart),
  };
}

const CSV_COLUMNS = [
  "logicalEventKey", "headSha", "predictionCreatedAt", "planMode", "testsSelectedDiffci", "testsTotalFull",
  "recordedRunId", "recordedRunPath", "recordedConclusion", "contaminationReason", "evidenceRunsForHead",
  "retroVerdict", "retroEvidenceRunId", "retroEvidenceConclusion", "retroEvidenceCreatedAt", "retroEvidenceCompletedAt",
  "predictionPrecededRetroEvidence", "predictionPrecededRetroEvidenceStart",
] as const;

export function toCsv(rows: readonly RetrospectiveRow[]): string {
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [CSV_COLUMNS.join(","), ...rows.map((r) => CSV_COLUMNS.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
}
