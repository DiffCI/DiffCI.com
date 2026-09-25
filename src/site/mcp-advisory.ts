import YAML from "yaml";

import { validateObservationReport, type ObservationReport, type WorkflowFinding } from "../client/report.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function reportNextAction(report: ObservationReport): string {
  if (report.status === "REFUSED" || report.status === "ERROR") {
    return "Run the repository's normal validation commands; this report is not a passing result.";
  }
  if (report.result?.mode === "FULL") {
    return "Run the full validation command. The report found no safe selective route.";
  }
  return "Use the selected command as change-impact evidence, then keep every required CI check authoritative.";
}

export function interpretObservationReport(value: unknown): Record<string, unknown> {
  const validated = validateObservationReport(value);
  if (!validated.ok) {
    return { valid: false, error: validated.error, nextAction: "Regenerate the report with the current DiffCI CLI." };
  }

  const report = validated.report;
  return {
    valid: true,
    schema: report.schema,
    status: report.status,
    stage: report.stage,
    reason: report.reason,
    mode: report.result?.mode,
    changedFileCount: report.result?.changedFileCount,
    selectedTestCount: report.result?.selectedTests.length,
    totalTestCount: report.result?.totalTestCount,
    fallbackReasons: report.result?.fallbackReasons ?? [],
    proposedCommands: report.result?.proposedCommands ?? [],
    worktreeUnchanged: report.nonInterference.worktreeUnchanged,
    reportWrittenOutsideRepository: report.nonInterference.reportWrittenOutsideRepository,
    workflowFindings: report.nonInterference.workflowFindings,
    nextAction: reportNextAction(report),
  };
}

function writePermissions(permissions: unknown): string[] {
  if (permissions === "write-all") return ["write-all"];
  if (!isRecord(permissions)) return [];
  return Object.entries(permissions).filter(([, level]) => level === "write").map(([scope]) => scope);
}

function isDiffCiStep(step: Record<string, unknown>): boolean {
  return (typeof step.uses === "string" && /diffci/i.test(step.uses)) ||
    (typeof step.run === "string" && /(?:^|\s|["'])@?[^\s"']*diffci/i.test(step.run));
}

function pinnedReference(step: Record<string, unknown>): boolean {
  if (typeof step.uses === "string") {
    if (step.uses.startsWith("./") || step.uses.startsWith("docker://")) return true;
    return /@[0-9a-f]{40}$/i.test(step.uses);
  }
  if (typeof step.run === "string") {
    const references = [...step.run.matchAll(/(@?[A-Za-z0-9._/-]*diffci[A-Za-z0-9._/-]*)@([^\s"']+)/gi)];
    return references.every((match) => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(match[2] ?? ""));
  }
  return true;
}

const allowedActions = ["actions/checkout", "actions/setup-node", "actions/cache", "actions/upload-artifact"];

export function verifyWorkflowText(workflowText: string): Record<string, unknown> {
  if (workflowText.length > 262_144) {
    return { valid: false, error: "workflow exceeds the 256 KiB advisory limit", findings: [] };
  }

  let document: unknown;
  try {
    document = YAML.parse(workflowText);
  } catch (error) {
    return {
      valid: false,
      error: `could not parse workflow YAML: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
      findings: [],
    };
  }
  if (!isRecord(document) || !isRecord(document.jobs)) {
    return { valid: false, error: "workflow must contain a jobs mapping", findings: [] };
  }

  const jobs = document.jobs;
  const findings: WorkflowFinding[] = [];
  const observerJobs: string[] = [];
  for (const [jobId, rawJob] of Object.entries(jobs)) {
    if (!isRecord(rawJob)) continue;
    const steps = asArray(rawJob.steps).filter(isRecord);
    const diffciSteps = steps.filter(isDiffCiStep);
    if (diffciSteps.length === 0) continue;
    observerJobs.push(jobId);

    const dependants = Object.entries(jobs)
      .filter(([otherId, otherJob]) => otherId !== jobId && isRecord(otherJob) && asArray(otherJob.needs).includes(jobId))
      .map(([otherId]) => otherId);
    if (dependants.length > 0) findings.push({
      severity: "BLOCKING", code: "JOB_IS_A_DEPENDENCY",
      message: `job "${jobId}" is listed in needs: by ${dependants.join(", ")}`,
      workflow: "submitted-workflow", job: jobId,
    });
    if (rawJob["continue-on-error"] !== true) findings.push({
      severity: "BLOCKING", code: "JOB_NOT_CONTINUE_ON_ERROR",
      message: `job "${jobId}" must set continue-on-error: true`, workflow: "submitted-workflow", job: jobId,
    });

    const foreignSteps = steps.filter((step) => {
      if (isDiffCiStep(step)) return false;
      if (typeof step.run === "string") return true;
      if (typeof step.uses !== "string") return false;
      const uses = step.uses;
      return !allowedActions.some((allowed) => uses === allowed || uses.startsWith(`${allowed}@`));
    });
    if (foreignSteps.length > 0) findings.push({
      severity: "BLOCKING", code: "JOB_NOT_DEDICATED",
      message: `job "${jobId}" contains ${foreignSteps.length} non-observation step(s)`, workflow: "submitted-workflow", job: jobId,
    });

    const permissions = rawJob.permissions === undefined ? document.permissions : rawJob.permissions;
    const writable = writePermissions(permissions);
    if (writable.length > 0) findings.push({
      severity: "WARNING", code: "JOB_HAS_WRITE_PERMISSIONS",
      message: `job "${jobId}" can write: ${writable.join(", ")}`, workflow: "submitted-workflow", job: jobId,
    });
    for (const step of diffciSteps) {
      if (!pinnedReference(step)) findings.push({
        severity: "WARNING", code: typeof step.uses === "string" ? "ACTION_NOT_PINNED" : "AGENT_NOT_PINNED",
        message: `job "${jobId}" uses a mutable DiffCI reference`, workflow: "submitted-workflow", job: jobId,
      });
    }
  }

  if (observerJobs.length === 0) findings.push({
    severity: "WARNING", code: "NO_OBSERVER_JOB",
    message: "no DiffCI step was found", workflow: "submitted-workflow",
  });
  return {
    valid: true,
    safe: observerJobs.length > 0 && !findings.some((finding) => finding.severity === "BLOCKING"),
    observerJobs,
    findings,
    boundary: "This is a stateless single-document advisory. Run the local diffci verify-workflow command for repository-aware verification.",
  };
}
