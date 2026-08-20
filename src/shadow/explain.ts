import type { ExecutionPlan } from "../planner/types.js";
import type { BaselineEvidence, ShadowRunIdentity, ShadowMeasuredMetrics } from "./types.js";

export function buildExplainArtifact(
  identity: ShadowRunIdentity,
  plan: ExecutionPlan,
  changedFiles: string[],
  baseline?: BaselineEvidence,
  measured?: ShadowMeasuredMetrics,
): string {
  const retained = plan.tasks.filter((t) => t.status !== "SKIP_CANDIDATE");
  const skipped = plan.tasks.filter((t) => t.status === "SKIP_CANDIDATE");
  const lines: string[] = [
    "# DiffCI Shadow Analysis",
    "",
    `Repository: ${identity.repository}`,
    `Commit: ${identity.headSha}`,
    `Base: ${identity.baseSha}`,
    `Logical key: ${identity.logicalKey}`,
    `Execution key: ${identity.executionKey}`,
    `Mode: ${plan.mode}`,
    "",
    "## Changed files",
    ...changedFiles.map((f) => `- ${f}`),
    "",
    "## Would run",
    ...retained.map((t) => `- ${t.id} (${t.status})${t.reason ? ` — ${t.reason}` : ""}`),
    "",
    "## Skip candidates",
    ...skipped.map((t) => `- ${t.id}${t.reason ? ` — ${t.reason}` : ""}`),
    "",
    "## Tests",
    `- Selected: ${plan.selectedTests.length}`,
    `- Skipped: ${plan.skippedTests.length}`,
    ...plan.selectedTests.map((p) => `  - (run) ${p}`),
    ...plan.skippedTests.slice(0, 20).map((p) => `  - (skip) ${p}`),
    ...(plan.skippedTests.length > 20 ? [`  ... and ${plan.skippedTests.length - 20} more`] : []),
  ];

  if (plan.fallbackReasons.length) {
    lines.push("", "## Fallback reasons", ...plan.fallbackReasons.map((r) => `- ${r}`));
  }

  if (baseline) {
    lines.push(
      "",
      "## Baseline CI observed",
      `- Runs: ${baseline.fullRunsObserved.length}`,
      `- Jobs: ${baseline.jobs.length}`,
      baseline.baselineDurationMs ? `- Total duration: ${(baseline.baselineDurationMs / 1000).toFixed(1)}s` : "",
      `- Failed jobs: ${baseline.failedJobNames.length ? baseline.failedJobNames.join(", ") : "none"}`,
    );
  }

  if (measured) {
    lines.push(
      "",
      "## Measured runtime opportunity",
      measured.baselineDurationMs ? `- Baseline measured: ${(measured.baselineDurationMs / 1000).toFixed(1)}s` : "",
      measured.skipCandidateDurationMs ? `- Skip-candidate duration: ${(measured.skipCandidateDurationMs / 1000).toFixed(1)}s` : "",
      measured.netPotentialTimeSavedMs ? `- Net potential time saved: ${(measured.netPotentialTimeSavedMs / 1000).toFixed(1)}s` : "",
      measured.netPotentialReductionPercent ? `- Net potential reduction: ${measured.netPotentialReductionPercent.toFixed(1)}%` : "",
    );
  }

  lines.push("", "## Safety", `- Fallback required: ${plan.safety.fallbackRequired}`, `- Graph confidence: ${plan.safety.graphConfidence}`);

  return lines.filter(Boolean).join("\n");
}
