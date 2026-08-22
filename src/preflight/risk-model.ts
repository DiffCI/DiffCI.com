/**
 * Failure-risk model v0 (Part 9) - a simple, fully interpretable additive score, deliberately not a
 * black-box ML model. Every contributing signal is a named, independently-inspectable reason
 * (risk_reasons[]) - Part 9: "Every risk prediction should be explainable."
 *
 * Weights below are hand-set starting points, not fit to data (Phase P0 has no shadow-prediction history
 * yet to fit against - that's Phase P1+'s job). They are deliberately small integers so the score stays
 * easy to reason about by inspection.
 */
export interface RiskSignalInput {
  changedFileTypes: string[]; // e.g. ['.ts', '.json']
  dependencyFanOut: number; // count of files transitively depending on the changed files
  affectedTestCount: number;
  historicalFailureRateForModule?: number; // 0-1, from the historical dataset (Part 5/6), if known
  matchesKnownFailureFingerprint: boolean;
  isConfigOrGlobalChange: boolean;
  isDependencyManifestChange: boolean;
  isMigrationOrSchemaChange: boolean;
  isGeneratedCodeChange: boolean;
}

export interface RiskReason {
  signal: string;
  weight: number;
  detail: string;
}

export interface RiskScoreResult {
  failureRiskScore: number; // unbounded additive score - NOT a probability; a future version may calibrate this to one
  riskReasons: RiskReason[];
}

export function computeFailureRiskScore(input: RiskSignalInput): RiskScoreResult {
  const reasons: RiskReason[] = [];

  if (input.isConfigOrGlobalChange) reasons.push({ signal: "config_or_global_change", weight: 5, detail: "a config/global-risk file changed - historically strongly correlated with FULL-fallback-class risk" });
  if (input.isDependencyManifestChange) reasons.push({ signal: "dependency_manifest_change", weight: 4, detail: "package.json/lockfile changed - real dependency-resolution failures are common here" });
  if (input.isMigrationOrSchemaChange) reasons.push({ signal: "migration_or_schema_change", weight: 4, detail: "a migration/schema file changed - failures here are often deterministic (schema validation) but high-blast-radius" });
  if (input.isGeneratedCodeChange) reasons.push({ signal: "generated_code_change", weight: 2, detail: "a generated-artifact file changed by hand, or its generator changed - drift risk" });
  if (input.matchesKnownFailureFingerprint) reasons.push({ signal: "known_failure_fingerprint_match", weight: 6, detail: "this change matches a previously-observed failure fingerprint - the strongest available signal" });
  if (input.dependencyFanOut > 20) reasons.push({ signal: "high_dependency_fan_out", weight: 3, detail: `${input.dependencyFanOut} files transitively depend on the change - wide blast radius` });
  else if (input.dependencyFanOut > 5) reasons.push({ signal: "moderate_dependency_fan_out", weight: 1, detail: `${input.dependencyFanOut} files transitively depend on the change` });
  if (input.affectedTestCount === 0) reasons.push({ signal: "zero_affected_tests", weight: 2, detail: "no tests are mapped to this change - a real regression could pass CI silently" });
  if (typeof input.historicalFailureRateForModule === "number" && input.historicalFailureRateForModule > 0.2) {
    reasons.push({ signal: "high_historical_module_failure_rate", weight: Math.round(input.historicalFailureRateForModule * 10), detail: `this module has historically failed ${(input.historicalFailureRateForModule * 100).toFixed(0)}% of the time it changed` });
  }

  const failureRiskScore = reasons.reduce((sum, r) => sum + r.weight, 0);
  return { failureRiskScore, riskReasons: reasons };
}
