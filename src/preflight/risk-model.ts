/**
 * Failure-risk model v0/v1 (Part 9, extended by Preflight P1 Part I) - a simple, fully interpretable
 * additive score, deliberately not a black-box ML model. Every contributing signal is a named,
 * independently-inspectable reason (risk_reasons[]) - Part 9: "Every risk prediction should be
 * explainable."
 *
 * Weights below are hand-set starting points, not fit to data (Phase P0 has no shadow-prediction history
 * yet to fit against - that's Phase P1+'s job). They are deliberately small integers so the score stays
 * easy to reason about by inspection.
 *
 * v1 (Part I) adds environment-parity signals, informed by runtime-parity.ts and the real
 * node:sqlite/Node-20-vs-22 incident. A live-detected environment-parity VERDICT (an actual
 * MAJOR_MISMATCH/CONFLICTING/INCOMPATIBLE result, not just "something plausibly risky changed") is
 * deterministic, near-certain-failure evidence - stronger than known_failure_fingerprint_match's
 * statistical recurrence, so it now carries the highest weight in the model. The remaining new signals
 * (isDockerfileChange, isCiWorkflowChange, isRuntimeRequirementChange,
 * dependencyRequiresNewerRuntimeThanDeclared) are leading indicators of POSSIBLE future drift, not
 * confirmed mismatches, and are weighted accordingly lower - never fabricated from a signal this
 * model can't actually observe (dependencyRequiresNewerRuntimeThanDeclared is only ever set true by a
 * caller that has genuinely checked a real dependency's own engines field against this repo's
 * declaration, never guessed).
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
  /** A live runtime-parity.ts verdict for this commit, if the runtime_parity check has already run.
   * Only "INCOMPATIBLE" | "MAJOR_MISMATCH" | "CONFLICTING" contribute risk - "COMPATIBLE"/
   * "NEWER_COMPATIBLE" contribute none, and "MISSING"/"MALFORMED" are deliberately NOT treated as risk
   * signals here (an unparseable or absent declaration is a gap in this model's own coverage, not
   * evidence the runtime is actually wrong - conflating the two would be exactly the kind of
   * fabricated-confidence this project's discipline forbids). */
  runtimeParityVerdict?: "COMPATIBLE" | "NEWER_COMPATIBLE" | "INCOMPATIBLE" | "MAJOR_MISMATCH" | "MISSING" | "CONFLICTING" | "MALFORMED";
  /** package.json engines.*, .nvmrc, or an equivalent runtime-requirement declaration changed in this diff. */
  isRuntimeRequirementChange?: boolean;
  /** A Dockerfile (or equivalent container/runner image definition) changed in this diff. */
  isDockerfileChange?: boolean;
  /** A CI workflow file changed in this diff. */
  isCiWorkflowChange?: boolean;
  /** Set only when a caller has genuinely verified a newly-added/updated dependency declares its own
   * engines requirement stricter than this repo's current declared runtime requirement - never
   * inferred or guessed. */
  dependencyRequiresNewerRuntimeThanDeclared?: boolean;
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

  // --- v1 environment-parity signals (Part I) ---------------------------------------------------
  if (input.runtimeParityVerdict === "MAJOR_MISMATCH" || input.runtimeParityVerdict === "CONFLICTING") {
    reasons.push({ signal: "runtime_parity_confirmed_mismatch", weight: 7, detail: `runtime-parity check returned ${input.runtimeParityVerdict} - a deterministic, near-certain-failure environment mismatch (the real node:sqlite/Node-20-vs-22 incident's exact shape), the strongest signal available to this model` });
  } else if (input.runtimeParityVerdict === "INCOMPATIBLE") {
    reasons.push({ signal: "runtime_parity_incompatible", weight: 6, detail: "runtime-parity check returned INCOMPATIBLE - the actual runtime does not satisfy a declared requirement" });
  }
  if (input.isRuntimeRequirementChange) reasons.push({ signal: "runtime_requirement_change", weight: 3, detail: "a runtime-requirement declaration (package.json engines, .nvmrc, or equivalent) changed - re-verify parity against every provisioning source" });
  if (input.isDockerfileChange) reasons.push({ signal: "dockerfile_change", weight: 3, detail: "a Dockerfile (or equivalent runner/container image definition) changed - a common source of the provisioning side of an environment-parity drift" });
  if (input.isCiWorkflowChange) reasons.push({ signal: "ci_workflow_change", weight: 2, detail: "a CI workflow file changed - can alter which runtime/runner a job actually executes on" });
  if (input.dependencyRequiresNewerRuntimeThanDeclared) reasons.push({ signal: "dependency_requires_newer_runtime", weight: 5, detail: "a changed dependency declares its own runtime requirement stricter than this repo's currently declared requirement - a real, verified mismatch waiting to surface" });

  const failureRiskScore = reasons.reduce((sum, r) => sum + r.weight, 0);
  return { failureRiskScore, riskReasons: reasons };
}
