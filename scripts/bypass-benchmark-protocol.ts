export interface TrainingRecord {
  index: number;
  headSha: string;
  contextKey: string;
  stable: boolean;
  pairs: Array<{ fullMs: number; policyMs: number; observerMs: number }>;
}

/** Preserve two-worker limits across Vitest's historical CLI rename. */
export function vitestWorkerArguments(help: string): string[] {
  if (/--maxWorkers\b/.test(help) && /--minWorkers\b/.test(help)) return ["--maxWorkers=2", "--minWorkers=2"];
  if (/--maxThreads\b/.test(help) && /--minThreads\b/.test(help)) return ["--maxThreads=2", "--minThreads=2"];
  throw new Error("Cannot establish compatible two-worker Vitest options");
}

/** Freeze only earlier training measurements; never learn from held-out outcomes. */
export function freezeTimingHistory(records: TrainingRecord[], options: {
  trainingCount: number; repository: string; jobKey: string;
  observerVersion: string; contextKey: string; recordedAt: string;
}) {
  if (records.some(record => record.index >= options.trainingCount || record.index < 0)) throw new Error("Held-out record leaked into timing history");
  const samples = records.filter(record => record.stable && record.contextKey === options.contextKey)
    .flatMap(record => record.pairs.filter(pair => [pair.fullMs, pair.policyMs, pair.observerMs].every(value => Number.isFinite(value) && value > 0))
      .map(pair => ({ headSha: record.headSha, stable: true, ...pair })));
  return { schema: "diffci.economics.v1", repository: options.repository, jobKey: options.jobKey,
    contextKey: options.contextKey, observerVersion: options.observerVersion, recordedAt: options.recordedAt, samples };
}

/** Identical full policies reuse measured full work; run-to-run noise is not saving. */
export function heldOutEconomics(input: {
  decision: "ANALYZE" | "BYPASS_FULL";
  fullMs: number; policyMs: number; gatedObserverMs: number; forcedObserverMs: number;
}) {
  const controlledTestMs = input.decision === "BYPASS_FULL" ? input.fullMs : input.policyMs;
  const alwaysAnalyzeNetMs = input.fullMs - input.policyMs - input.forcedObserverMs;
  const controlledNetMs = input.fullMs - controlledTestMs - input.gatedObserverMs;
  return { ...input, controlledTestMs, alwaysAnalyzeNetMs, controlledNetMs,
    improvementOverAlwaysAnalyzeMs: controlledNetMs - alwaysAnalyzeNetMs,
    missedProfitableSelection: input.decision === "BYPASS_FULL" && alwaysAnalyzeNetMs > 0 };
}
