import { createHash } from "node:crypto";

type Json = Record<string, any>;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const hex = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const list = (value: unknown): value is string[] => Array.isArray(value) && value.every(hex) && new Set(value).size === value.length;
const object = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const mono = (value: unknown): bigint | null => typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : null;

export interface PairArtifact { pair: unknown; predictionBytes: Buffer; receiptBytes: Buffer }

// Explicit historical cohorts: upgrading a producer never silently authorizes a new selector.
export const DENTALPRESENCE_SELECTOR_PINS: Readonly<Record<string, string>> = {
  "0.2.11": "sha512-c6mWfEU7P6k+nroa0LO7/NJyR/Ubzoa36mh3XRoWSOzkZwYIcGC+2QfbM+gHzCWsAqWew4sM0KT3XleSrjqosg==",
  "0.3.2": "sha512-45tYPyabvMjrhlJCPtEP0UUeIVY567XZl6eGsIXy1LSHADmr9Dj1VSvh7HIAtfea03ZbTwhJ2s8sh/YTSU8Mwg==",
};
export const dentalPresenceSelectorPins = DENTALPRESENCE_SELECTOR_PINS;

/** Recompute eligibility from the artifacts, never trust producer assessment booleans. */
function inspectPair(input: PairArtifact) {
  const invalid = (reason: string) => ({ accepted: false as const, reason });
  const pair = input.pair;
  if (!object(pair) || pair.schema !== "dentalpresence.diffci.pair.v1") return invalid("INVALID_SCHEMA");
  if (pair.seededMutation) return invalid("SEEDED_EXPERIMENT");
  if (pair.repository !== "adityankale190895/DentalPresence.in" || typeof pair.workflowRef !== "string" ||
      !/^adityankale190895\/DentalPresence\.in\/\.github\/workflows\/paired-ci-evidence\.yml@refs\//.test(pair.workflowRef) ||
      !/^\d+$/.test(String(pair.runId ?? "")) || !/^[1-9]\d*$/.test(String(pair.runAttempt ?? "")) ||
      !/^\d+$/.test(String(pair.providerRepositoryId ?? "")) || pair.job !== "paired-evidence" ||
      pair.eventSha !== pair.executedSha || typeof pair.workflowSha !== "string" || !/^[a-f0-9]{40}$/.test(pair.workflowSha)) return invalid("CI_IDENTITY_UNVERIFIED");
  if (pair.status !== "COMPLETE" || pair.cleanupConfirmed !== true || pair.isolation !== "independent-local-clones" ||
      pair.cachePolicy !== "fresh-workspaces-no-restored-test-cache" || pair.checkoutTextPolicy !== "canonical-git-lf" || !hex(pair.harnessSha256)) return invalid("INCOMPLETE_PROTOCOL");
  if (![pair.executedSha, pair.baseSha].every((sha) => typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha))) return invalid("COMMIT_IDENTITY");
  let prediction: Json; let receipt: Json;
  try {
    const parsedPrediction: unknown = JSON.parse(input.predictionBytes.toString("utf8"));
    const parsedReceipt: unknown = JSON.parse(input.receiptBytes.toString("utf8"));
    if (!object(parsedPrediction) || !object(parsedReceipt)) return invalid("INVALID_PREDICTION");
    prediction = parsedPrediction; receipt = parsedReceipt;
  } catch { return invalid("INVALID_PREDICTION"); }
  const identity = pair.prediction;
  if (!object(identity) || identity.frozenSha256 !== hash(input.predictionBytes) || identity.finalSha256 !== identity.frozenSha256 ||
      receipt.frozenSha256 !== identity.frozenSha256 || receipt.frozenAt !== identity.frozenAt ||
      receipt.frozenMonotonicNs !== identity.frozenMonotonicNs || receipt.headSha !== pair.executedSha || receipt.baseSha !== pair.baseSha ||
      identity.headSha !== pair.executedSha || identity.baseSha !== pair.baseSha || prediction.schema !== "diffci.observation.v1" ||
      prediction.status !== "OBSERVED" || prediction.commitRange?.headSha !== pair.executedSha || prediction.commitRange?.baseSha !== pair.baseSha ||
      prediction.nonInterference?.worktreeUnchanged !== true) return invalid("PREDICTION_IDENTITY");
  const version = pair.selectorPackage?.version;
  if (typeof version !== "string" || !Object.hasOwn(dentalPresenceSelectorPins, version) ||
      pair.selectorPackage.integrity !== dentalPresenceSelectorPins[version] ||
      prediction.observer?.version !== pair.selectorPackage.version || identity.selectorVersion !== pair.selectorPackage.version) return invalid("SELECTOR_IDENTITY");
  if (pair.mode !== "SELECTIVE" || prediction.result?.mode !== "SELECTIVE") return invalid("FULL_FALLBACK");
  const files: unknown = prediction.result.selectedTests;
  if (!Array.isArray(files) || !files.length || files.some((file) => typeof file !== "string") || new Set(files).size !== files.length ||
      prediction.result.commandRefusalReason || prediction.result.blindSpot || prediction.result.unroutedTestPaths?.length) return invalid("UNEXECUTABLE_SELECTION");
  if (!list(pair.fullFileIds) || !list(pair.selectedFileIds) || pair.fullFileIds.length !== pair.fullTestFiles ||
      pair.selectedFileIds.length !== pair.selectedTestFiles || !hex(pair.universeSha256) ||
      pair.selectedFileIds.some((file: string) => !pair.fullFileIds.includes(file)) ||
      JSON.stringify([...pair.selectedFileIds].sort()) !== JSON.stringify(files.map((file) => hash(file)).sort())) return invalid("UNIVERSE_MISMATCH");
  if (!Array.isArray(pair.mandatoryPhaseIndices) || pair.mandatoryPhaseIndices.some((index: unknown) => !Number.isInteger(index))) return invalid("MANDATORY_PHASES_UNVERIFIED");
  const frozenAt = Date.parse(identity.frozenAt);
  const frozenMono = mono(identity.frozenMonotonicNs);
  if (!Number.isFinite(frozenAt) || frozenMono === null || !Number.isFinite(Date.parse(prediction.producedAt)) ||
      Date.parse(prediction.producedAt) > frozenAt || !Number.isFinite(pair.analysisWallMs) || pair.analysisWallMs < 0) return invalid("INVALID_TIMING");
  const allOutcomes: Json[][] = [];
  for (const role of ["full", "selected"]) {
    const arm = pair[role];
    const expectedFiles: string[] = role === "full" ? pair.fullFileIds : pair.selectedFileIds;
    if (!object(arm) || arm.role !== role || !["PASS", "FAIL"].includes(arm.status) || arm.checkoutStable !== true ||
        arm.executedSha !== pair.executedSha || arm.universeSha256 !== pair.universeSha256 || !Number.isFinite(arm.wallMs) || arm.wallMs <= 0 ||
        !Number.isFinite(Date.parse(arm.startedAt)) || !Number.isFinite(Date.parse(arm.completedAt)) || Date.parse(arm.completedAt) < Date.parse(arm.startedAt) ||
        frozenAt > Date.parse(arm.startedAt) || mono(arm.startedMonotonicNs) === null ||
        mono(arm.startedMonotonicNs)! <= frozenMono) return invalid("EXECUTION_OR_PROSPECTIVITY");
    if (!Array.isArray(arm.phases) || arm.phases.length !== arm.expectedPhaseCount ||
        pair.mandatoryPhaseIndices.some((index: number) => !arm.phases.some((phase: Json) => phase.index === index && phase.mandatory === true)) ||
        arm.phases.some((phase: Json) => !["PASS", "FAIL"].includes(phase.status) || phase.signal !== null || !Number.isInteger(phase.exitCode) ||
          (phase.status === "PASS" ? phase.exitCode !== 0 : phase.exitCode <= 0)) ||
        (arm.status === "PASS") !== arm.phases.every((phase: Json) => phase.status === "PASS")) return invalid("PHASE_COMPLETENESS");
    if (arm.coverageComplete !== true || arm.fileErrors !== 0 || arm.unattributed !== 0 || !list(arm.seenFileIds) ||
        expectedFiles.some((file) => !arm.seenFileIds.includes(file)) || !Array.isArray(arm.outcomes) ||
        arm.outcomes.some((outcome: Json) => !object(outcome) || outcome.kind !== "test" || !hex(outcome.testId) ||
          !expectedFiles.includes(outcome.fileId) || !["PASS", "FAIL", "SKIP", "TODO"].includes(outcome.status)) ||
        new Set(arm.outcomes.map((outcome: Json) => outcome.testId)).size !== arm.outcomes.length) return invalid("TEST_COVERAGE");
    allOutcomes.push(arm.outcomes);
  }
  const failed = allOutcomes[0].filter((test) => test.status === "FAIL");
  const selectedFailures = new Set(allOutcomes[1].filter((test) => test.status === "FAIL").map((test) => test.testId));
  const omittedFailures = failed.filter((test) => !pair.selectedFileIds.includes(test.fileId)).length;
  return { accepted: true as const, id: `${pair.runId}:${pair.runAttempt}:${pair.executedSha}`, headSha: pair.executedSha as string,
    selectorVersion: version,
    possibleMiss: pair.selected.status === "PASS" && omittedFailures > 0,
    fullFailingCases: failed.length, correspondingFailingCases: failed.filter((test) => selectedFailures.has(test.testId)).length,
    omittedFailingCases: omittedFailures, performanceEligible: pair.full.status === "PASS" && pair.selected.status === "PASS",
    fullWallMs: pair.full.wallMs as number, selectedWallMs: pair.selected.wallMs as number, analysisWallMs: pair.analysisWallMs as number };
}

export function inspectDentalPresencePair(input: PairArtifact) {
  try { return inspectPair(input); }
  catch { return { accepted: false as const, reason: "MALFORMED_RECORD" }; }
}

export function summarizeDentalPresencePairs(inputs: PairArtifact[]) {
  const accepted = new Map<string, Extract<ReturnType<typeof inspectDentalPresencePair>, { accepted: true }>>();
  const canonical = new Map<string, string>(); const conflicts = new Set<string>();
  const exclusions: Record<string, number> = {}; let duplicateDeliveries = 0;
  for (const input of inputs) {
    const id = object(input.pair) ? `${String(input.pair.runId)}:${String(input.pair.runAttempt)}:${String(input.pair.executedSha)}` : null;
    const digest = hash(`${JSON.stringify(input.pair) ?? "null"}\n${hash(input.predictionBytes)}\n${hash(input.receiptBytes)}`);
    if (id && canonical.has(id)) {
      if (canonical.get(id) === digest) duplicateDeliveries++;
      else { conflicts.add(id); accepted.delete(id); }
      continue;
    }
    if (id) canonical.set(id, digest);
    const result = inspectDentalPresencePair(input);
    if (!result.accepted) { exclusions[result.reason] = (exclusions[result.reason] ?? 0) + 1; continue; }
    accepted.set(result.id, result);
  }
  if (conflicts.size) exclusions.CONFLICTING_PAIR = conflicts.size;
  const pairs = [...accepted.values()]; const performance = pairs.filter((pair) => pair.performanceEligible);
  const fullWallMs = performance.reduce((sum, pair) => sum + pair.fullWallMs, 0);
  const selectedWallMs = performance.reduce((sum, pair) => sum + pair.selectedWallMs, 0);
  const analysisWallMs = performance.reduce((sum, pair) => sum + pair.analysisWallMs, 0);
  const cohorts = Object.fromEntries([...new Set(pairs.map((pair) => pair.selectorVersion))].sort().map((version) => {
    const cohort = pairs.filter((pair) => pair.selectorVersion === version);
    const measured = cohort.filter((pair) => pair.performanceEligible);
    const full = measured.reduce((sum, pair) => sum + pair.fullWallMs, 0);
    const selected = measured.reduce((sum, pair) => sum + pair.selectedWallMs, 0);
    const analysis = measured.reduce((sum, pair) => sum + pair.analysisWallMs, 0);
    return [version, { acceptedPairs: cohort.length, performancePairs: measured.length,
      possibleMissPairs: cohort.filter((pair) => pair.possibleMiss).length,
      fullWallMs: full, selectedWallMs: selected, analysisWallMs: analysis,
      netRuntimeReduction: full ? 1 - (selected + analysis) / full : null }];
  }));
  return { schema: "diffci.dentalpresence.paired-summary.v1", inputArtifacts: inputs.length, duplicateDeliveries,
    acceptedPairs: pairs.length, performancePairs: performance.length, possibleMissPairs: pairs.filter((pair) => pair.possibleMiss).length,
    fullFailingCases: pairs.reduce((sum, pair) => sum + pair.fullFailingCases, 0),
    omittedFailingCases: pairs.reduce((sum, pair) => sum + pair.omittedFailingCases, 0), exclusions, cohorts,
    fullWallMs, selectedWallMs, analysisWallMs,
    grossRuntimeReduction: fullWallMs ? 1 - selectedWallMs / fullWallMs : null,
    netRuntimeReduction: fullWallMs ? 1 - (selectedWallMs + analysisWallMs) / fullWallMs : null,
    regressionRecall: null, computeSavings: null, realizedSavings: null,
    evidenceLimit: "Preliminary instrumented runtime pairs; UNKNOWN failures need reproduction. Setup/storage costs are excluded from this ratio. Imported JSON is not authenticated; fetch artifacts from the expected repository." };
}
