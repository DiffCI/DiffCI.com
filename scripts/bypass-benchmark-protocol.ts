export interface TrainingRecord {
  index: number;
  headSha: string;
  contextKey: string;
  stable: boolean;
  pairs: Array<{ fullMs: number; policyMs: number; observerMs: number }>;
}

/** Preserve two-worker limits using each verified Vitest interface. */
export function vitestWorkerConfiguration(help: string, version: string): { args: string[]; env: Record<string, string> } {
  if (/--maxWorkers\b/.test(help) && /--minWorkers\b/.test(help)) return { args: ["--maxWorkers=2", "--minWorkers=2"], env: {} };
  if (/--maxWorkers\b/.test(help) && /\bvitest\/[45]\./.test(version)) return { args: ["--maxWorkers=2"], env: {} };
  // Vitest 0.34.6 reads these in node/config.ts; it has no maxThreads CLI flag.
  if (/\bvitest\/0\.34\.6\b/.test(version) && /--threads\b/.test(help)) return { args: ["--threads"], env: { VITEST_MAX_THREADS: "2", VITEST_MIN_THREADS: "2" } };
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
