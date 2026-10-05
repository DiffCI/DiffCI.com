import { createHash } from "node:crypto";
import { validateObservationReport } from "../../src/client/report.js";
import { selectionComparison } from "./observation-selection.js";

const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): number | "unknown" => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : "unknown";
const boolean = (value: unknown): boolean | "unknown" => typeof value === "boolean" ? value : "unknown";
const text = (value: unknown): string => typeof value === "string" ? value : "unknown";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map((entry) => JSON.parse(canonical(entry))));
  if (object(value)) return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map((key) => [key, JSON.parse(canonical(value[key]))])));
  return JSON.stringify(value);
}

/** Imported reports are observations, not authenticated CI executions or failure-recall evidence. */
export function readObservationCorpus(inputs: unknown[]) {
  const records = new Map<string, { digest: string; report: Record<string, any> }>();
  const conflicts = new Set<string>();
  let invalidRecords = 0; let duplicateDeliveries = 0;
  for (const input of inputs) {
    if (!validateObservationReport(input).ok || !object(input) || !object(input.repository) || !object(input.observer) ||
        !object(input.ci) || !object(input.commitRange) || !object(input.timings) || !object(input.nonInterference) ||
        typeof input.repository.ownerName !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(input.repository.ownerName) ||
        !/^\d+$/.test(String(input.repository.providerRepositoryId ?? "")) || input.ci.provider !== "github-actions" ||
        !/^\d+$/.test(String(input.ci.runId ?? "")) || !/^[1-9]\d*$/.test(String(input.ci.runAttempt ?? "")) ||
        typeof input.ci.job !== "string" || !input.ci.job || typeof input.observer.version !== "string" || !input.observer.version ||
        ![input.commitRange.baseSha, input.commitRange.headSha, input.observer.engineSha].every((value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value))) {
      invalidRecords++; continue;
    }
    const id = JSON.stringify([input.repository.providerRepositoryId, input.ci.runId, input.ci.runAttempt, input.ci.job]);
    const digest = createHash("sha256").update(canonical(input)).digest("hex");
    const previous = records.get(id);
    if (previous) {
      if (previous.digest === digest) duplicateDeliveries++;
      else conflicts.add(id);
    } else records.set(id, { digest, report: input });
  }
  const rows = [...records.entries()].filter(([id]) => !conflicts.has(id)).map(([, { report }]) => {
    const result = object(report.result) ? report.result : {};
    const baseline = object(result.pathBaseline) ? result.pathBaseline : {};
    const graph = object(result.graph) ? result.graph : {};
    const comparison = selectionComparison(result.mode, Array.isArray(result.selectedTests) ? result.selectedTests.length : undefined,
      result.totalTestCount, baseline.mode, baseline.selectedTestCount);
    const notes: string[] = [];
    if (report.nonInterference.worktreeUnchanged === false) notes.push("NON-INTERFERENCE VIOLATED");
    if (report.payload.includesEnvironment !== false) notes.push("PRIVACY VIOLATED: environment boundary unverified");
    return {
      identity: { repository: report.repository.ownerName as string, stresses: "imported CI observation; no test execution",
        baseSha: report.commitRange.baseSha as string, headSha: report.commitRange.headSha as string,
        agentVersion: report.observer.version as string, agentIntegrity: `engine:${report.observer.engineSha}` },
      understanding: { testUniverse: count(result.totalTestCount), graphNodes: count(graph.nodes), graphConfidence: text(graph.confidence), changedFiles: count(result.changedFileCount) },
      decision: { status: text(report.status), mode: report.status === "OBSERVED" ? text(result.mode) : text(report.status),
        reason: Array.isArray(result.fallbackReasons) ? result.fallbackReasons.filter((value: unknown) => typeof value === "string").join("; ") : text(report.reason),
        selected: comparison.selected, total: count(result.totalTestCount) },
      counterfactual: { baselineMode: text(baseline.mode), baselineSelected: comparison.baselineSelected, netVersusBaseline: comparison.netVersusBaseline },
      integrity: { worktreeUnchanged: boolean(report.nonInterference.worktreeUnchanged), reportOutsideRepository: boolean(report.nonInterference.reportWrittenOutsideRepository),
        includesFileContents: boolean(report.payload.includesFileContents), includesEnvironment: boolean(report.payload.includesEnvironment), includesCredentials: boolean(report.payload.includesCredentials) },
      economics: { analysisMs: count(report.timings.totalMs) }, notes,
    };
  });
  return { rows, inputRecords: inputs.length, invalidRecords, duplicateDeliveries, conflictingExecutions: conflicts.size };
}
