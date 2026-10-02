/** Operator-only pilot artifact reporting, outside the repository-neutral engine. */
export function summarizeDentalPresenceEvidence(inputs: unknown[]) {
  const seen = new Map<string, string>();
  const duplicates = new Set<string>();
  const conflicts = new Set<string>();
  const accepted = new Map<string, { status: "PASS" | "FAIL"; wallMs: number; sha: string }>();
  const exclusions: Record<string, number> = {};
  const exclude = (reason: string) => { exclusions[reason] = (exclusions[reason] ?? 0) + 1; };
  for (const input of inputs) {
    if (!input || typeof input !== "object" || Array.isArray(input)) { exclude("INVALID_RECORD"); continue; }
    const row = input as Record<string, unknown>;
    if (row.schema !== "dentalpresence.diffci.full-execution.v1" || typeof row.executionId !== "string" || !row.executionId) {
      exclude("INVALID_SCHEMA_OR_ID"); continue;
    }
    // Ignore property order when comparing a repeated JSON delivery.
    const canonical = JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))));
    const previous = seen.get(row.executionId);
    if (previous !== undefined) {
      if (previous === canonical) duplicates.add(row.executionId);
      else { conflicts.add(row.executionId); accepted.delete(row.executionId); }
      continue;
    }
    seen.set(row.executionId, canonical);
    if (row.repository !== "adityankale190895/DentalPresence.in") { exclude("REPOSITORY_MISMATCH"); continue; }
    if (typeof row.workflowRef !== "string" || !/^adityankale190895\/DentalPresence\.in\/\.github\/workflows\/cloudflare-staging-deploy\.yml@refs\//.test(row.workflowRef)) {
      exclude("WORKFLOW_MISMATCH"); continue;
    }
    const sha = /^[a-f0-9]{40}$/;
    if (typeof row.executedSha !== "string" || !sha.test(row.executedSha) || row.executedSha !== row.eventSha ||
        typeof row.workflowSha !== "string" || !sha.test(row.workflowSha)) { exclude("COMMIT_IDENTITY_UNVERIFIED"); continue; }
    if (row.initiallyClean !== true || row.headUnchanged !== true || row.inputsUnchanged !== true) { exclude("CHECKOUT_UNVERIFIED"); continue; }
    if ((row.job !== "full-test-evidence" || row.event !== "pull_request") &&
        (row.job !== "deploy" || !["push", "workflow_dispatch"].includes(String(row.event)))) {
      exclude("JOB_OR_EVENT_MISMATCH"); continue;
    }
    if (row.role !== "full" || row.command !== "npm test" ||
        !["commandSha256", "packageSha256", "lockfileSha256"].every((key) => typeof row[key] === "string" && /^[a-f0-9]{64}$/.test(String(row[key])))) {
      exclude("COMMAND_IDENTITY_UNVERIFIED"); continue;
    }
    const start = typeof row.startedAt === "string" ? Date.parse(row.startedAt) : NaN;
    const end = typeof row.completedAt === "string" ? Date.parse(row.completedAt) : NaN;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start ||
        typeof row.wallMs !== "number" || !Number.isFinite(row.wallMs) || row.wallMs < 0 ||
        !/^\d+$/.test(String(row.runId ?? "")) || !/^[1-9]\d*$/.test(String(row.runAttempt ?? ""))) {
      exclude("INCOMPLETE_EXECUTION"); continue;
    }
    if (!/^\d+$/.test(String(row.providerRepositoryId ?? "")) ||
        row.executionId !== `${String(row.providerRepositoryId)}:${String(row.runId)}:${String(row.runAttempt)}:${String(row.job)}`) {
      exclude("EXECUTION_ID_MISMATCH"); continue;
    }
    if ((row.status !== "PASS" && row.status !== "FAIL") || !Number.isInteger(row.exitCode) ||
        (row.status === "PASS" ? row.exitCode !== 0 : Number(row.exitCode) <= 0) || row.signal !== null) {
      exclude("NON_TEST_OR_INCOMPLETE_OUTCOME"); continue;
    }
    accepted.set(row.executionId, { status: row.status, wallMs: row.wallMs, sha: row.executedSha });
  }
  if (conflicts.size) exclusions.CONFLICTING_EXECUTION_ID = conflicts.size;
  const rows = [...accepted.values()];
  return {
    schema: "diffci.dentalpresence.execution-summary.v1", inputRecords: inputs.length,
    duplicateExecutionIds: duplicates.size, acceptedExecutions: rows.length,
    uniqueCommits: new Set(rows.map((row) => row.sha)).size,
    fullCommandPasses: rows.filter((row) => row.status === "PASS").length,
    fullCommandFailuresUnclassified: rows.filter((row) => row.status === "FAIL").length,
    fullCommandWallMs: rows.reduce((sum, row) => sum + row.wallMs, 0), exclusions,
    failurePreservation: null, measuredSavings: null,
    evidenceLimit: "Aggregate npm test results only; imported JSON is not authenticated. No per-test, prospective paired selection, resource, or deployment evidence.",
  };
}
