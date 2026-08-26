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
import type { ShadowRepositoryReport, StageRollup } from "./shadow-report-rollup.js";

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
  }
  return lines;
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

  L.push(`DiffCI observed ${report.commitsObserved} commits (${report.workflowRunsObserved} workflow runs) in this window.`);
  L.push(`${seconds(report.totalObservedMs)}s (${hours(report.totalObservedMs)} runner-hours) of CI compute across those runs  [MEASURED]`);
  L.push("");
  // Load-bearing honesty: observation is sampled (bounded per sweep), so these totals are a LOWER BOUND on
  // what this repository actually spent, never a census of it. Without this line a maintainer reads the
  // headline as their weekly CI bill, sees a number far too small, and correctly discards the report.
  L.push("These totals cover only the commits DiffCI observed, which is a sample rather than a complete");
  L.push("census of this repository's CI. Treat them as a lower bound on actual consumption.");
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
  L.push("");
  L.push("  DiffCI made no change to this repository's CI. Nothing was skipped, cancelled or modified.");

  return L.join("\n");
}
