/**
 * Renders a ShadowRepositoryReport as plain text (External Shadow Pilot M3, 2026-08-26).
 *
 * Separate from the rollup so the numbers can be tested without asserting on prose, and so the vocabulary
 * rules below live in exactly one place.
 *
 * VOCABULARY RULES, enforced by tests rather than left to care:
 *  - The word "saved" never appears. Shadow mode changes nothing about the customer's pipeline, so nothing
 *    has been saved. The term is reserved for the activation phase, where a selected subset actually runs.
 *  - Avoidable figures are always qualified: "estimated avoidable compute", never a bare duration.
 *  - Every estimated line is accompanied by the evidence underneath it - selection ratio, measured full
 *    workload, and an explicit "selected execution: not yet measured" - so a reader can object to the
 *    inference without having to take the number on trust. A maintainer who can see the reasoning is far
 *    likelier to believe a modest claim than one handed a flattering headline.
 *  - The linear-cost caveat is stated in the report itself, not just in the code: at small selection
 *    ratios the estimate overstates, because per-invocation overhead is not modeled.
 */
import type { CiStage } from "../shadow/stage-classification.js";
import type { CommitDetail, ShadowRepositoryReport, StageRollup } from "./shadow-report-rollup.js";
import { estimateStageEconomics } from "./economics-estimator.js";

function hours(ms: number): string {
  return (ms / 3_600_000).toFixed(2);
}
function seconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}
function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

const STAGE_LABEL: Record<CiStage, string> = {
  test: "tests",
  build: "build",
  lint: "lint",
  typecheck: "typecheck",
  e2e: "e2e",
  other: "other CI",
};

function renderStageLine(stage: StageRollup): string {
  const label = STAGE_LABEL[stage.stage];
  const observed = `  ${seconds(stage.observedMs).padStart(8)}s  ${label}`;
  if (stage.estimatedAvoidableMs === undefined) {
    // Explicitly "unknown opportunity", never omitted and never rendered as zero - an absent line would
    // read as "this stage does not exist" and a zero would read as "DiffCI checked and there is nothing
    // here". Neither is true; the truth is that DiffCI cannot yet classify this stage at all.
    return `${observed}  -  measured consumption, unknown opportunity`;
  }
  const partial = stage.unknownRows > 0 ? ` (${stage.estimatedRows} of ${stage.estimatedRows + stage.unknownRows} observations estimable)` : "";
  return `${observed}  -  measured consumption, estimated avoidable compute: ${seconds(stage.estimatedAvoidableMs)}s${partial}`;
}

/**
 * YC readiness Week 2 - the incremental-economics comparator. Answers, per commit: what did full CI
 * cost, what would the path-rule baseline (src/planner/path-baseline.ts) have cost, what did DiffCI
 * select, what did DiffCI's own analysis cost, and what is the incremental difference after paying for
 * that analysis. Structurally mirrors scripts/dogfood-economics.ts's measured
 * `incrementalCpu = comparatorCpu - (diffciSelectedCpu + jointAnalysisCpu)`, but every selected-workload
 * term here is an ESTIMATE (shadow mode executes neither counterfactual) rather than a measured
 * CPU-second - the vocabulary must say so every time, because "DiffCI selected fewer tests than the path
 * rule" is not by itself a savings claim once DiffCI's own analysis cost is paid for.
 */
interface ComparatorEstimate {
  /** ESTIMATED - what the path-rule baseline would have cost, had it run. */
  pathSelectedMs: number | undefined;
  /** ESTIMATED - what DiffCI's own selection would have cost, had it run. */
  diffciSelectedMs: number | undefined;
  /** MEASURED - DiffCI's real analysis wall-time for this commit. */
  analysisMs: number | undefined;
  /** ESTIMATED - pathSelectedMs - (diffciSelectedMs + analysisMs). Positive means DiffCI wins even after
   * paying for its own analysis; negative means the path rule would have been cheaper overall. Undefined
   * whenever any input is unavailable - never defaulted to zero, which would misreport "no difference"
   * when the truth is "not comparable yet". */
  incrementalMs: number | undefined;
}

function comparatorFor(c: CommitDetail): ComparatorEstimate {
  // An inseparable measurement (one step that installs/typechecks AND tests) is not a test-stage
  // workload, so neither side of the comparator may be estimated from it (2026-09-05, step 3).
  if (c.workloadInseparable || typeof c.testsTotalFull !== "number" || c.testsTotalFull <= 0) {
    return { pathSelectedMs: undefined, diffciSelectedMs: undefined, analysisMs: c.diffciAnalysisOverheadMs, incrementalMs: undefined };
  }
  // planMode is deliberately NOT passed to either call: it names DiffCI's own plan, and applying it to
  // the path-rule's independent selection would misapply the estimator's FULL-implies-ratio-1 shortcut
  // to a strategy that never declared FULL. Both sides get the same treatment - the raw selected/total
  // ratio - so the comparison is symmetric.
  const path =
    typeof c.testsSelectedPath === "number"
      ? estimateStageEconomics({ stage: "test", fullWorkloadMs: c.fullWorkloadMs, testsSelectedDiffci: c.testsSelectedPath, testsTotalFull: c.testsTotalFull, planMode: undefined })
      : undefined;
  const diffci =
    typeof c.testsSelectedDiffci === "number"
      ? estimateStageEconomics({ stage: "test", fullWorkloadMs: c.fullWorkloadMs, testsSelectedDiffci: c.testsSelectedDiffci, testsTotalFull: c.testsTotalFull, planMode: undefined })
      : undefined;
  const pathSelectedMs = path?.selectedWorkloadMs;
  const diffciSelectedMs = diffci?.selectedWorkloadMs;
  const analysisMs = c.diffciAnalysisOverheadMs;
  const incrementalMs =
    typeof pathSelectedMs === "number" && typeof diffciSelectedMs === "number" && typeof analysisMs === "number" ? pathSelectedMs - (diffciSelectedMs + analysisMs) : undefined;
  return { pathSelectedMs, diffciSelectedMs, analysisMs, incrementalMs };
}

function renderCommitEvidence(stage: StageRollup): string[] {
  const lines: string[] = ["", "  Evidence, per observed commit (test stage):"];
  for (const c of stage.commits) {
    const ratio = typeof c.testsSelectedDiffci === "number" && typeof c.testsTotalFull === "number" ? `${c.testsSelectedDiffci} / ${c.testsTotalFull} tests` : "selection unknown";
    lines.push(`    ${c.headSha.slice(0, 8)}  plan: ${c.planMode ?? "unknown"}   selected: ${ratio}`);
    lines.push(`              full workload (measured):        ${seconds(c.fullWorkloadMs)}s`);
    if (c.avoidableTier === "ESTIMATED" && typeof c.estimatedAvoidableMs === "number") {
      // A plan that selected everything avoided nothing, and saying "up to 0.0s" makes that read like a
      // failed estimate rather than a definite, correct answer.
      lines.push(
        c.estimatedAvoidableMs === 0
          ? `              estimated avoidable compute:     none - this plan selected every test`
          : `              estimated avoidable compute:     up to ${seconds(c.estimatedAvoidableMs)}s`,
      );
    } else {
      lines.push(`              estimated avoidable compute:     not estimable`);
    }
    lines.push(`              confidence:                      ${c.avoidableTier}`);
    lines.push(`              selected execution:              not yet measured`);

    // The incremental-economics comparator: DiffCI vs the path-rule baseline, not merely vs FULL.
    const cmp = comparatorFor(c);
    if (typeof c.testsSelectedPath === "number" && typeof c.testsTotalFull === "number") {
      lines.push(`              path-rule would select (comparator): ${c.testsSelectedPath} / ${c.testsTotalFull} tests`);
    }
    const notEstimable = c.workloadInseparable ? "not estimable (inseparable workload: measured step mixes non-test work)" : "not estimable";
    lines.push(`              path-rule estimated cost:        ${typeof cmp.pathSelectedMs === "number" ? `${seconds(cmp.pathSelectedMs)}s [ESTIMATED]` : notEstimable}`);
    lines.push(`              DiffCI selected estimated cost: ${typeof cmp.diffciSelectedMs === "number" ? `${seconds(cmp.diffciSelectedMs)}s [ESTIMATED]` : notEstimable}`);
    lines.push(`              DiffCI analysis cost:            ${typeof cmp.analysisMs === "number" ? `${seconds(cmp.analysisMs)}s [MEASURED]` : "not recorded"}`);
    if (typeof cmp.incrementalMs === "number") {
      const sign = cmp.incrementalMs > 0 ? "DiffCI ahead" : cmp.incrementalMs < 0 ? "path rule ahead" : "no difference";
      lines.push(`              incremental estimated difference: ${cmp.incrementalMs >= 0 ? "+" : ""}${seconds(cmp.incrementalMs)}s (${sign}) [ESTIMATED]`);
      lines.push(`                = path-rule cost - (DiffCI selected cost + DiffCI analysis cost)`);
    } else {
      lines.push(`              incremental estimated difference: not comparable yet`);
    }
  }
  return lines;
}

/**
 * Repository-level incremental-economics total, summed as raw components rather than averaged ratios
 * (a tiny cheap commit must not outvote a large expensive one - same discipline as
 * scripts/dogfood-economics.ts's own TOTALS section). Only sums commits where every term is available;
 * a commit missing any input is excluded from the total rather than silently treated as zero.
 */
function renderComparatorTotal(testStage: StageRollup | undefined): string[] {
  if (!testStage) return [];
  const comparable = testStage.commits.map((c) => comparatorFor(c)).filter((cmp) => typeof cmp.incrementalMs === "number");
  if (comparable.length === 0) {
    return ["", "Incremental economics vs the path-rule baseline", "  Not yet comparable - no observed commit carries every input this comparator needs."];
  }
  const sum = (pick: (c: ComparatorEstimate) => number | undefined): number => comparable.reduce((acc, c) => acc + (pick(c) ?? 0), 0);
  const path = sum((c) => c.pathSelectedMs);
  const diffci = sum((c) => c.diffciSelectedMs);
  const analysis = sum((c) => c.analysisMs);
  const incremental = path - (diffci + analysis);
  const L = [
    "",
    `Incremental economics vs the path-rule baseline, over ${comparable.length} comparable commit(s)  [ESTIMATED]`,
    `  path-rule estimated cost         ${seconds(path)}s`,
    `  DiffCI selected estimated cost   ${seconds(diffci)}s`,
    `  DiffCI analysis cost (measured)  ${seconds(analysis)}s`,
    `  incremental estimated difference ${incremental >= 0 ? "+" : ""}${seconds(incremental)}s (${incremental > 0 ? "DiffCI ahead" : incremental < 0 ? "path rule ahead" : "no difference"})`,
    "  Neither side's selected subset was executed - both figures are projections from the same",
    "  linear-cost model as the rest of this report, and the sign can flip once DiffCI's own analysis cost",
    "  is paid for even when DiffCI selected fewer tests than the path rule would have. Treat this as the",
    "  answer to \"would a simple path rule have been cheaper here\", not as compute already avoided.",
  ];
  return L;
}

export function renderShadowReport(report: ShadowRepositoryReport): string {
  const L: string[] = [];
  const days = Math.round((new Date(report.windowEndIso).getTime() - new Date(report.windowStartIso).getTime()) / 86_400_000);

  L.push(`DiffCI shadow observation - ${report.repository}`);
  L.push(`Window: last ${days} days (${report.windowStartIso.slice(0, 10)} to ${report.windowEndIso.slice(0, 10)})`);
  L.push("");

  if (!report.hasSufficientData) {
    // Never a page of zeros. "Nothing was observed" and "your CI consumed nothing" are entirely different
    // claims, and only the first one is true here.
    L.push(report.insufficientReason ?? "Insufficient data to report.");
    L.push("");
    L.push("This is a statement about DiffCI's observation coverage, not about this repository's activity.");
    L.push("No estimate is offered, because there is nothing to base one on.");
    return L.join("\n");
  }

  const ev = report.evidence;

  // State first, before any number. DiffCI decides when it has earned the right to make a recommendation;
  // it does not show every fresh installation a percentage after one lucky selective commit.
  L.push(ev.state === "EVIDENCE_READY" ? "STATUS: SHADOW - EVIDENCE READY" : "STATUS: SHADOW - COLLECTING");
  L.push("");

  // Observation coverage comes BEFORE the economics. "3 commits observed" is meaningless until the reader
  // knows whether the total was 4 or 47 - those are completely different reports.
  L.push("Observation coverage");
  L.push(`  DiffCI observed ${ev.capturedPredictions} of ${ev.eligiblePredictions} eligible commits in this period` + (ev.captureCoverage === undefined ? "." : ` (${pct(ev.captureCoverage)} capture coverage).`));
  L.push(`  ${ev.selectiveObservations} produced a SELECTIVE plan; ${ev.fullObservations} produced FULL plans.`);
  L.push("  These measurements are a sample of repository CI activity, not total weekly CI usage.");
  L.push("  Estimates below apply only to the observed workloads, and are a lower bound on actual consumption.");
  L.push("");
  L.push(`${seconds(report.totalObservedMs)}s (${hours(report.totalObservedMs)} runner-hours) of CI compute across ${report.workflowRunsObserved} observed workflow runs  [MEASURED]`);
  L.push("");
  L.push("By stage:");
  for (const stage of report.stages) L.push(renderStageLine(stage));
  L.push("");

  if (report.totalEstimatedAvoidableMs === undefined) {
    L.push(`No avoidable compute could be estimated in this window.`);
  } else {
    L.push(`${seconds(report.totalEstimatedAvoidableMs)}s  total estimated avoidable compute (test stage only, v1)   [ESTIMATED]`);
  }
  L.push(`${seconds(report.totalMeasuredAvoidableMs)}s  total measured avoidable compute`);
  L.push(`         (shadow mode never executes the selected subset, so this is structurally zero - expected, not a gap)`);
  L.push("");
  L.push(`${pct(report.classifiedFraction)} of observed CI work is currently classifiable by DiffCI (test stage only)`);
  if (report.safety.evaluableFailures === 0) {
    // "0 missed failures" out of 0 evaluable failures is absence of evidence, not evidence of safety.
    // Reporting it as a safety result would be the single most misleading number in this document.
    L.push("No CI failures occurred in the observed window, so DiffCI's selection safety could not be");
    L.push("evaluated here. This is an absence of evidence, not evidence that selection is safe.");
  } else {
    L.push(`${report.safety.falseNegatives} observed missed failures, out of ${report.safety.evaluableFailures} evaluable failures (${report.safety.failuresPreserved} preserved by DiffCI's selection)`);
  }

  const testStage = report.stages.find((s) => s.stage === "test");
  if (testStage) L.push(...renderCommitEvidence(testStage));
  L.push(...renderComparatorTotal(testStage));

  L.push("");
  if (ev.state === "COLLECTING") {
    L.push("Evidence still accumulating");
    L.push(`  DiffCI has observed ${ev.capturedPredictions} eligible commits, including ${ev.selectiveObservations} selective ` + (ev.selectiveObservations === 1 ? "opportunity" : "opportunities") + ".");
    L.push("  More observations are required before DiffCI recommends enabling optimization:");
    for (const c of ev.unmetCriteria) L.push(`    - ${c}`);
    if (!ev.canMakePositiveSafetyStatement) {
      L.push("    - no failing execution has been evaluable yet, so selection safety remains untested");
    }
    L.push("  DiffCI makes no recommendation at this coverage.");
  } else {
    L.push("Evidence threshold reached");
    L.push("  This report rests on enough observations to be worth acting on. It still describes potential");
    L.push("  opportunity, not validated savings - see below.");
  }
  L.push("");
  L.push("How to read this report");
  L.push("  MEASURED  - real timings from this repository's own completed GitHub Actions runs.");
  L.push("  ESTIMATED - a projection of what DiffCI's selection WOULD have cost. The selected subset was");
  L.push("              never executed, so this is inference, not observation.");
  L.push("  UNKNOWN   - DiffCI cannot yet classify this stage. Reported as unknown rather than as zero.");
  L.push("");
  L.push("  The estimate assumes every test costs the same and models no fixed per-invocation overhead");
  L.push("  (container startup, dependency install, compilation). At small selection ratios it therefore");
  L.push("  OVERSTATES avoidable compute - a run of one test still pays the suite's startup cost.");
  L.push("  Treat these figures as potential opportunity to investigate, not as compute already avoided.");
  L.push("  They are deliberately NOT extrapolated into a monthly or annual figure: the relationship between");
  L.push("  what DiffCI observed and this repository's total CI activity is not yet characterised well");
  L.push("  enough to scale them honestly.");
  L.push("");
  L.push("  DiffCI made no change to this repository's CI. Nothing was skipped, cancelled or modified.");

  return L.join("\n");
}
