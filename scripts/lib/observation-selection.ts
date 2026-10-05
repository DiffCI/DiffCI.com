/** Impact candidates are not the execution selection when a plan requires FULL validation. */
export function effectiveTestCount(mode: unknown, selected: unknown, total: unknown): number | "unknown" {
  const count = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
  if (!count(total)) return "unknown";
  if (mode === "FULL") return total;
  return mode === "SELECTIVE" && count(selected) && selected <= total ? selected : "unknown";
}

export function selectionComparison(mode: unknown, selected: unknown, total: unknown, baselineMode: unknown, baselineSelected: unknown) {
  const effectiveSelected = effectiveTestCount(mode, selected, total);
  const effectiveBaseline = effectiveTestCount(baselineMode, baselineSelected, total);
  return { selected: effectiveSelected, baselineSelected: effectiveBaseline,
    netVersusBaseline: typeof effectiveSelected === "number" && typeof effectiveBaseline === "number"
      ? effectiveBaseline - effectiveSelected : "unknown" as const };
}

export interface SelectionObservation {
  identity: { repository: string; agentVersion: string; agentIntegrity?: string; baseSha: string; headSha: string };
  decision: { status: string; mode: string; selected: unknown; total: unknown };
  counterfactual: { baselineMode: string; baselineSelected: unknown };
  economics: { analysisMs: unknown };
}

/** Inventory counts describe observations, not independent experiments or measured savings. */
export function summarizeSelectionCohorts(rows: SelectionObservation[]) {
  const groups = new Map<string, SelectionObservation[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.identity.repository, row.identity.agentVersion, row.identity.agentIntegrity ?? "unknown"]);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, cohort]) => {
    const [repository, version, integrity] = JSON.parse(key) as string[];
    const comparisons = cohort.map((row) => row.decision.status === "OBSERVED"
      ? selectionComparison(row.decision.mode, row.decision.selected, row.decision.total, row.counterfactual.baselineMode, row.counterfactual.baselineSelected).netVersusBaseline
      : "unknown");
    const durations = cohort.map((row) => row.economics.analysisMs)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
    const middle = Math.floor(durations.length / 2);
    return { repository, version, integrity, observations: cohort.length,
      uniqueDeltas: new Set(cohort.map((row) => JSON.stringify([row.identity.baseSha, row.identity.headSha]))).size,
      full: cohort.filter((row) => row.decision.status === "OBSERVED" && row.decision.mode === "FULL").length,
      selective: cohort.filter((row) => row.decision.status === "OBSERVED" && row.decision.mode === "SELECTIVE").length,
      fewer: comparisons.filter((value) => typeof value === "number" && value > 0).length,
      same: comparisons.filter((value) => value === 0).length,
      more: comparisons.filter((value) => typeof value === "number" && value < 0).length,
      unknownComparisons: comparisons.filter((value) => value === "unknown").length,
      timingObservations: durations.length,
      medianAnalysisMs: durations.length ? (durations.length % 2 ? durations[middle] : (durations[middle - 1] + durations[middle]) / 2) : null,
      p90AnalysisMs: durations.length ? durations[Math.ceil(durations.length * 0.9) - 1] : null,
      maxAnalysisMs: durations.length ? durations[durations.length - 1] : null };
  });
}
