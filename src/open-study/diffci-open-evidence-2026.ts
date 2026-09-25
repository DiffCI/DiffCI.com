// DiffCI Open Evidence Study 2026 - the single source of every number in the study.
//
// Modelled on DentalPresence's CC BY 4.0 country studies (src/lib/research/*-findings.ts there):
// the study page, the CSV, the PDF and the LICENSE.txt are ALL rendered from this one module by
// scripts/render-open-study.ts, so there is no second copy of any figure to drift out of sync.
//
// Rules this file follows (docs/website/README.md, docs/website/03-evidence-ledger.md):
//   1. Every figure carries an evidence level and a source path inside this repository.
//   2. Unflattering numbers stay in. The 4.2% aggregate sits next to the 94.3% conditional win rate.
//   3. Named repositories are public projects analysed from public data. None is a customer.
//   4. Nothing here says "saved" for a figure that was not executed and timed.
//
// Plain data only - no DOM, no React, no pdf-lib - so it is importable from a tsx script and a test.

export type EvidenceLevel =
  | "MEASURED" // a clock or a counter produced this number in a real execution
  | "PREDICTED" // a frozen rule's prediction, recorded before the measurement it predicted
  | "PROCESS_FACT" // something that happened (a rule was frozen, a run was excluded), not a measurement
  | "ABSTAINED"; // DiffCI declined to produce a number; the abstention itself is the finding

export type Figure = {
  readonly id: string;
  readonly category: string;
  readonly metric: string;
  readonly value: string;
  readonly unit: string;
  readonly scope: string;
  readonly level: EvidenceLevel;
  readonly source: string;
  readonly note?: string;
};

export type TableRow = readonly string[];

export type StudyTable = {
  readonly id: string;
  readonly caption: string;
  readonly columns: readonly string[];
  readonly numericColumns: readonly number[];
  readonly rows: readonly TableRow[];
};

export type BarDatum = {
  readonly label: string;
  readonly value: number;
  readonly note?: string;
  /** Id of the figure this value must equal. tests/open-study/open-study.test.ts enforces it. */
  readonly figure?: string;
  /** Colour slot for stacked segments: neutral (no decision possible), setup (no win), tests (a win). */
  readonly tone?: "neutral" | "setup" | "tests";
};

export type StudyChart = {
  readonly id: string;
  readonly title: string;
  /** diverging-bars: signed values around zero. bars: 0..max, one colour. stacked-single: one 100% bar. */
  readonly kind: "diverging-bars" | "stacked-single" | "bars";
  readonly unit: string;
  readonly caption: string;
  readonly data: readonly BarDatum[];
  /** Decimal places for value labels (default 1). */
  readonly decimals?: number;
  /** Scale maximum for `bars` (default: the largest value). */
  readonly max?: number;
  /** Legend text for `diverging-bars` (default: fewer/more tests than the path rule). */
  readonly legend?: { readonly positive: string; readonly negative: string };
};

export type StudySection = {
  readonly id: string;
  readonly title: string;
  /** Light inline HTML is allowed: <strong>, <em>, <code>. The PDF renderer strips tags. */
  readonly paragraphs: readonly string[];
  readonly tables?: readonly StudyTable[];
  readonly charts?: readonly StudyChart[];
  readonly bullets?: readonly string[];
};

export type StudyFindings = {
  readonly studyId: string;
  readonly studyName: string;
  readonly subtitle: string;
  readonly version: string;
  readonly asOf: string;
  readonly updatedAsOf: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly publisher: string;
  readonly pagePath: string;
  readonly downloadDir: string;
  readonly license: { readonly name: string; readonly url: string };
  readonly disclaimer: string;
  readonly lede: string;
  readonly headlineFindings: readonly { readonly id: string; readonly value: string; readonly label: string }[];
  readonly sections: readonly StudySection[];
  readonly notEstablished: readonly string[];
  readonly figures: readonly Figure[];
  readonly sourceReports: readonly { readonly path: string; readonly what: string }[];
  /**
   * Documents published beside the study at permanent, versioned URLs. A permalink is a promise:
   * the file at that path is never edited or moved (tests/open-study/permalinks.test.ts pins its
   * hash). A corrected version gets a new `-v2` file and a new entry; the old one stays.
   */
  readonly companionDocuments: readonly { readonly label: string; readonly href: string; readonly what: string }[];
};

const STAGE0 = "docs/research/2026-08-21-stage0-full-experiment-final-report.md";
const CALCOM_11 = "docs/research/2026-08-24-calcom-execution-observability/11-frozen-identity-and-complete-job-savings.md";
const CALCOM_13 = "docs/research/2026-08-24-calcom-execution-observability/13-five-merge-batch-results.md";
const DEEPSEEK_07 = "docs/research/2026-08-25-deepseek-execution-validation/07-execution-and-economics.md";
const DEEPSEEK_09 = "docs/research/2026-08-25-deepseek-execution-validation/09-aggregate-and-comparison.md";
const ECON = "docs/compute-economics-results.md";
const SAFETY = "docs/safety-validation-milestone.md";
const HONO_XENV = "docs/hono-cross-environment-reproduction.md";
const EXTERNAL = "docs/external-validation-conclusion.md";
const IMMER_PRED = "docs/immer-prediction-frozen.md";
const GENC = "docs/generation-c-observation-result.md";
const MI02 = "docs/mechanism-isolation-02-result.md";
const POSITION = "docs/position-and-next-phase.md";
const DENSITY = "docs/mapping-density-survey.md";
const FUNNEL = "docs/qualification-funnel.md";
const SMALL = "docs/survey-small-repo-diagnostic.md";
const CIREP05 = "docs/ci-reproduction-05-result.md";
const COVERAGE = "docs/engine-coverage-01-plan.md";
const ITEM1 = "docs/evidence/engine-coverage-01-item-1/results.md";
const PREFLIGHT = "docs/research/2026-08-22-preflight-p1-replay-results.md";
const LEDGER = "docs/website/03-evidence-ledger.md";
const METRICS = "docs/yc/metrics.md";
const SYMBOL = "docs/symbol-precision-result.md";

/** Every number that appears anywhere in the study. The CSV is this array, verbatim. */
export const figures: readonly Figure[] = [
  // ---- Stage 0: the 2,000-delta historical benchmark
  { id: "stage0-repositories", category: "stage0", metric: "repositories", value: "20", unit: "repositories", scope: "Stage 0 corpus", level: "MEASURED", source: STAGE0 },
  { id: "stage0-deltas", category: "stage0", metric: "commit_deltas", value: "2000", unit: "deltas", scope: "Stage 0 corpus", level: "MEASURED", source: STAGE0, note: "COUNT(DISTINCT logical_delta_key) = COUNT(*) = 2000, verified by direct D1 query" },
  { id: "stage0-deltas-analysed", category: "stage0", metric: "deltas_in_test_level_aggregates", value: "1899", unit: "deltas", scope: "Stage 0 corpus", level: "MEASURED", source: STAGE0, note: "excludes sindresorhus/ky (unreliable AVA test counts) and one impossible-count anomaly" },
  { id: "stage0-anomaly-excluded", category: "stage0", metric: "deltas_excluded_as_anomalous", value: "1", unit: "deltas", scope: "pmndrs/valtio", level: "PROCESS_FACT", source: STAGE0, note: "0.05% of deltas; testsSelectedByDiffci > testsTotal; excluded rather than patched mid-benchmark" },
  { id: "stage0-bucket-fallback", category: "stage0", metric: "mandatory_fallback_share", value: "60.3", unit: "percent", scope: "1,899 deltas (1,146)", level: "MEASURED", source: STAGE0 },
  { id: "stage0-bucket-optimal", category: "stage0", metric: "baseline_already_optimal_share", value: "9.9", unit: "percent", scope: "1,899 deltas (188)", level: "MEASURED", source: STAGE0 },
  { id: "stage0-bucket-opportunity", category: "stage0", metric: "discriminative_opportunity_share", value: "29.8", unit: "percent", scope: "1,899 deltas (565)", level: "MEASURED", source: STAGE0 },
  { id: "stage0-win-rate", category: "stage0", metric: "diffci_win_rate_within_opportunities", value: "94.3", unit: "percent", scope: "565 opportunity deltas (533 wins, 32 ties)", level: "MEASURED", source: STAGE0 },
  { id: "stage0-path-wins", category: "stage0", metric: "path_rule_wins_within_opportunities", value: "0", unit: "deltas", scope: "565 opportunity deltas", level: "MEASURED", source: STAGE0 },
  { id: "stage0-conditional-median", category: "stage0", metric: "median_reduction_vs_path_within_opportunities", value: "95.0", unit: "percent", scope: "565 opportunity deltas", level: "MEASURED", source: STAGE0 },
  { id: "stage0-conditional-mean", category: "stage0", metric: "mean_reduction_vs_path_within_opportunities", value: "66.0", unit: "percent", scope: "565 opportunity deltas", level: "MEASURED", source: STAGE0 },
  { id: "stage0-agg-vs-full", category: "stage0", metric: "aggregate_reduction_vs_full", value: "13.2", unit: "percent", scope: "1,899 deltas, test-count weighted", level: "MEASURED", source: STAGE0 },
  { id: "stage0-path-vs-full", category: "stage0", metric: "path_rule_aggregate_reduction_vs_full", value: "9.4", unit: "percent", scope: "1,899 deltas, test-count weighted", level: "MEASURED", source: STAGE0 },
  { id: "stage0-agg-vs-path", category: "stage0", metric: "aggregate_reduction_vs_path", value: "4.2", unit: "percent", scope: "1,899 deltas, test-count weighted", level: "MEASURED", source: STAGE0, note: "4.16% unrounded; the medium batch had read 24.6%" },
  { id: "stage0-unconditional-median", category: "stage0", metric: "median_task_reduction_vs_full_unconditional", value: "0.0", unit: "percent", scope: "all deltas", level: "MEASURED", source: STAGE0 },
  { id: "stage0-small-repos", category: "stage0", metric: "aggregate_reduction_vs_path_small_repositories", value: "44.9", unit: "percent", scope: "10 repositories below median source-file count", level: "MEASURED", source: STAGE0 },
  { id: "stage0-large-repos", category: "stage0", metric: "aggregate_reduction_vs_path_large_repositories", value: "-0.95", unit: "percent", scope: "9 repositories above median source-file count", level: "MEASURED", source: STAGE0, note: "statistically indistinguishable from zero" },
  { id: "stage0-bootstrap-ci", category: "stage0", metric: "aggregate_reduction_bootstrap_95ci", value: "-4.8 to +47.9", unit: "percent", scope: "repository-clustered bootstrap", level: "MEASURED", source: STAGE0, note: "crosses zero: this sample cannot rule out a null population effect" },
  { id: "stage0-full-fallback-repos", category: "stage0", metric: "repositories_at_100pct_fallback_or_unsafe", value: "7", unit: "repositories", scope: "of 20", level: "MEASURED", source: STAGE0, note: "date-fns, mikro-orm, nestjs, execa, trpc, typeorm, unocss" },
  { id: "stage0-failures", category: "stage0", metric: "historical_ci_failures_observed", value: "280", unit: "failures", scope: "154 distinct failing deltas, job level", level: "MEASURED", source: STAGE0 },
  { id: "stage0-diffci-misses", category: "stage0", metric: "diffci_unsafe_misses", value: "10", unit: "failures", scope: "of 280", level: "MEASURED", source: STAGE0 },
  { id: "stage0-path-misses", category: "stage0", metric: "path_rule_unsafe_misses", value: "82", unit: "failures", scope: "of 280", level: "MEASURED", source: STAGE0 },
  { id: "stage0-diffci-recall", category: "stage0", metric: "diffci_job_level_failure_recall", value: "96.4", unit: "percent", scope: "280 historical failures", level: "MEASURED", source: STAGE0 },
  { id: "stage0-path-recall", category: "stage0", metric: "path_rule_job_level_failure_recall", value: "70.7", unit: "percent", scope: "280 historical failures", level: "MEASURED", source: STAGE0 },
  { id: "stage0-overhead-median", category: "stage0", metric: "analysis_overhead_median", value: "1426", unit: "ms", scope: "1,900 timed records", level: "MEASURED", source: STAGE0 },
  { id: "stage0-overhead-p90", category: "stage0", metric: "analysis_overhead_p90", value: "3676", unit: "ms", scope: "1,900 timed records", level: "MEASURED", source: STAGE0 },
  { id: "stage0-overhead-max", category: "stage0", metric: "analysis_overhead_max", value: "52426", unit: "ms", scope: "typeorm/typeorm cold graph", level: "MEASURED", source: STAGE0, note: "investigated, not removed" },
  { id: "stage0-methodology-frozen", category: "stage0", metric: "methodology_frozen_before_execution", value: "5c9e936", unit: "commit", scope: "13 files, SHA-256 hashed", level: "PROCESS_FACT", source: STAGE0 },

  // ---- Executed replays: cal.com and deepseek-harness
  { id: "replay-merges-executed", category: "executed-replays", metric: "merges_with_full_and_selected_paths_executed_and_timed", value: "10", unit: "merges", scope: "cal.com 6 + deepseek-harness 4", level: "MEASURED", source: LEDGER, note: "deepseek-harness #2844 withheld because the runner did not honour the selection" },
  { id: "replay-honoured", category: "executed-replays", metric: "runtime_selection_honoured", value: "12 of 13", unit: "executions", scope: "both repositories", level: "MEASURED", source: DEEPSEEK_09, note: "11 HONORED_EXACTLY, 1 HONORED_WITH_FRAMEWORK_EXPANSION, 1 IGNORED_OR_BROADENED (withheld)" },
  { id: "calcom-test-stage", category: "executed-replays", metric: "test_stage_net_reduction", value: "86.0 to 91.6", unit: "percent", scope: "cal.com, 5 predeclared merges", level: "MEASURED", source: CALCOM_13 },
  { id: "calcom-job-level", category: "executed-replays", metric: "complete_job_net_reduction", value: "44.2", unit: "percent", scope: "cal.com PR #29940", level: "MEASURED", source: CALCOM_11 },
  { id: "calcom-install", category: "executed-replays", metric: "install_stage_wall", value: "319.7", unit: "seconds", scope: "cal.com PR #29940, paid on both paths", level: "MEASURED", source: CALCOM_11 },
  { id: "calcom-pretest", category: "executed-replays", metric: "pretest_stage_wall", value: "17.1", unit: "seconds", scope: "cal.com PR #29940, prisma generate", level: "MEASURED", source: CALCOM_11 },
  { id: "calcom-test-full", category: "executed-replays", metric: "test_stage_wall_full", value: "320.9", unit: "seconds", scope: "cal.com PR #29940", level: "MEASURED", source: CALCOM_11 },
  { id: "calcom-test-selected", category: "executed-replays", metric: "test_stage_wall_selected", value: "20.0", unit: "seconds", scope: "cal.com PR #29940", level: "MEASURED", source: CALCOM_11 },
  { id: "calcom-selected-files", category: "executed-replays", metric: "test_files_selected_of_total", value: "1 to 5 of 249-250", unit: "files", scope: "cal.com, 5 predeclared merges", level: "MEASURED", source: CALCOM_13 },
  { id: "calcom-honoured", category: "executed-replays", metric: "runtime_selection_honoured_exactly", value: "8 of 8", unit: "executions", scope: "cal.com", level: "MEASURED", source: CALCOM_13 },
  { id: "calcom-recall", category: "executed-replays", metric: "mutation_recall_measurable_cases", value: "3 of 3", unit: "cases", scope: "cal.com, unique measurable mutations", level: "MEASURED", source: DEEPSEEK_09 },
  { id: "calcom-infra-failures", category: "executed-replays", metric: "infrastructure_failures", value: "0 of 8", unit: "executions", scope: "cal.com", level: "MEASURED", source: CALCOM_13 },
  { id: "deepseek-test-stage", category: "executed-replays", metric: "test_stage_net_reduction", value: "83.5 to 94.3", unit: "percent", scope: "deepseek-harness, 4 eligible merges", level: "MEASURED", source: DEEPSEEK_07 },
  { id: "deepseek-job-level", category: "executed-replays", metric: "complete_job_net_reduction", value: "79.5 to 89.5", unit: "percent", scope: "deepseek-harness, 4 eligible merges", level: "MEASURED", source: DEEPSEEK_07 },
  { id: "deepseek-job-2760", category: "executed-replays", metric: "complete_job_net_reduction", value: "89.5", unit: "percent", scope: "deepseek-harness PR #2760 (760.2s full, 58.7s selected)", level: "MEASURED", source: DEEPSEEK_07 },
  { id: "deepseek-install", category: "executed-replays", metric: "install_stage_wall", value: "23 to 39", unit: "seconds", scope: "deepseek-harness", level: "MEASURED", source: DEEPSEEK_07 },
  { id: "deepseek-test-full", category: "executed-replays", metric: "test_stage_wall_full", value: "480.9 to 722.7", unit: "seconds", scope: "deepseek-harness", level: "MEASURED", source: DEEPSEEK_07 },
  { id: "deepseek-recall", category: "executed-replays", metric: "mutation_recall_measurable_cases", value: "3 of 3", unit: "cases", scope: "deepseek-harness; 2 further cases correctly unmeasurable", level: "MEASURED", source: DEEPSEEK_09 },
  { id: "deepseek-baseline-failures", category: "executed-replays", metric: "pre_existing_baseline_failures_per_run", value: "16 to 18", unit: "tests", scope: "deepseek-harness, every run", level: "MEASURED", source: DEEPSEEK_09 },
  { id: "deepseek-withheld", category: "executed-replays", metric: "merges_withheld_not_counted", value: "1 of 5", unit: "merges", scope: "deepseek-harness PR #2844", level: "ABSTAINED", source: DEEPSEEK_07 },

  // ---- Compute economics against a path-rule comparator
  { id: "hono-full-cpu", category: "compute-economics", metric: "full_suite_cpu", value: "1928.94", unit: "CPU-s", scope: "honojs/hono, 22 candidates, canonical container", level: "MEASURED", source: ECON },
  { id: "hono-comparator-cpu", category: "compute-economics", metric: "path_rule_comparator_cpu", value: "439.12", unit: "CPU-s", scope: "honojs/hono", level: "MEASURED", source: ECON },
  { id: "hono-diffci-cpu", category: "compute-economics", metric: "diffci_selected_cpu", value: "447.71", unit: "CPU-s", scope: "honojs/hono", level: "MEASURED", source: ECON },
  { id: "hono-analysis-cpu", category: "compute-economics", metric: "diffci_analysis_cpu", value: "72.31", unit: "CPU-s", scope: "honojs/hono, charged entirely to DiffCI", level: "MEASURED", source: ECON },
  { id: "hono-gross", category: "compute-economics", metric: "gross_cpu_saving_vs_full", value: "+1408.92", unit: "CPU-s", scope: "honojs/hono", level: "MEASURED", source: ECON },
  { id: "hono-incremental", category: "compute-economics", metric: "incremental_cpu_vs_path_rule", value: "-80.90", unit: "CPU-s", scope: "honojs/hono", level: "MEASURED", source: ECON, note: "negative: DiffCI lost to the comparator on this repository" },
  { id: "hono-incremental-signs", category: "compute-economics", metric: "per_candidate_incremental_sign", value: "4 positive, 18 negative", unit: "candidates", scope: "honojs/hono", level: "MEASURED", source: ECON },
  { id: "hono-overbroad", category: "compute-economics", metric: "selection_overbroad", value: "12 of 20", unit: "candidates", scope: "honojs/hono measurable mutations", level: "MEASURED", source: ECON },
  { id: "hono-toll", category: "compute-economics", metric: "fixed_analysis_toll_per_candidate", value: "~3.3", unit: "CPU-s", scope: "honojs/hono", level: "MEASURED", source: ECON },
  { id: "hono-recall", category: "compute-economics", metric: "mutation_recall_measurable_cases", value: "20 of 20", unit: "cases", scope: "honojs/hono, canonical container", level: "MEASURED", source: SAFETY },
  { id: "hono-reproduced", category: "compute-economics", metric: "host_classifications_reproduced_in_canonical_environment", value: "13 of 13", unit: "candidates", scope: "honojs/hono", level: "MEASURED", source: HONO_XENV },
  { id: "zod-recall", category: "compute-economics", metric: "mutation_recall_measurable_cases", value: "5 of 5", unit: "cases", scope: "colinhacks/zod", level: "MEASURED", source: SAFETY },
  { id: "zod-selection", category: "compute-economics", metric: "tests_selected_diffci_vs_comparator_vs_full", value: "629 / 761 / 967", unit: "tests", scope: "colinhacks/zod, 5 confirmed cases", level: "MEASURED", source: SAFETY },
  { id: "zod-efficient", category: "compute-economics", metric: "selection_efficient", value: "4 of 5", unit: "candidates", scope: "colinhacks/zod", level: "MEASURED", source: SAFETY },
  { id: "canonical-false-greens", category: "compute-economics", metric: "false_greens", value: "0", unit: "cases", scope: "25 canonical recall-measurable cases, hono + zod", level: "MEASURED", source: SAFETY },
  { id: "immer-predicted", category: "compute-economics", metric: "predicted_incremental_cpu", value: "+129.67", unit: "CPU-s", scope: "immerjs/immer, frozen before economics ran", level: "PREDICTED", source: IMMER_PRED },
  { id: "immer-measured", category: "compute-economics", metric: "measured_incremental_cpu", value: "+46.97", unit: "CPU-s", scope: "immerjs/immer", level: "MEASURED", source: EXTERNAL, note: "sign matched the frozen prediction; magnitude not validated" },
  { id: "immer-matched", category: "compute-economics", metric: "post_hoc_matched_subset_predicted_vs_measured", value: "+85.19 vs +46.97", unit: "CPU-s", scope: "immerjs/immer, 7 measured candidates", level: "MEASURED", source: EXTERNAL },
  { id: "immer-per-file", category: "compute-economics", metric: "cpu_per_test_file_modelled_vs_observed_at_1_to_2_files", value: "0.6539 vs ~2.7", unit: "CPU-s/file", scope: "immerjs/immer", level: "MEASURED", source: EXTERNAL, note: "the linear model under-prices small selections; the error inflates predicted savings" },
  { id: "immer-comparator", category: "compute-economics", metric: "full_vs_comparator_vs_diffci_total_cpu", value: "79.02 / 79.51 / 32.54", unit: "CPU-s", scope: "immerjs/immer", level: "MEASURED", source: EXTERNAL, note: "the comparator degenerates to FULL here; DiffCI is not beating a comparator that works" },
  { id: "genc-incremental", category: "compute-economics", metric: "incremental_cpu_vs_path_rule", value: "+71.48", unit: "CPU-s", scope: "eslint-plugin-jest, GENERATION_C_01 sealed target", level: "MEASURED", source: POSITION },
  { id: "genc-selection", category: "compute-economics", metric: "files_selected_diffci_vs_comparator_of_universe", value: "2 / 164 of 174", unit: "files", scope: "eslint-plugin-jest, GENERATION_C_01", level: "MEASURED", source: GENC },
  { id: "genc-graph-reached", category: "compute-economics", metric: "files_reached_through_dependency_graph", value: "0", unit: "files", scope: "eslint-plugin-jest, GENERATION_C_01", level: "MEASURED", source: GENC, note: "both selected files were directly changed; a changed-files rule would have tied" },
  { id: "genc-analysis", category: "compute-economics", metric: "analysis_cpu", value: "2.80", unit: "CPU-s", scope: "eslint-plugin-jest, GENERATION_C_01", level: "MEASURED", source: GENC },
  { id: "mi01-incremental", category: "compute-economics", metric: "incremental_cpu_vs_path_rule", value: "+43.81", unit: "CPU-s", scope: "eslint-plugin-jest, MI-01 (recall unmeasurable)", level: "MEASURED", source: MI02 },
  { id: "mi02-incremental", category: "compute-economics", metric: "incremental_cpu_vs_path_rule", value: "+53.56", unit: "CPU-s", scope: "eslint-plugin-jest, MI-02 (recall unmeasurable)", level: "MEASURED", source: MI02 },
  { id: "mi02-selection", category: "compute-economics", metric: "files_selected_diffci_vs_comparator_of_universe", value: "2 / 149 of 159", unit: "files", scope: "eslint-plugin-jest, MI-02", level: "MEASURED", source: MI02 },
  { id: "graph-reached-observations", category: "compute-economics", metric: "independent_graph_reach_observations", value: "2", unit: "observations", scope: "eslint-plugin-jest, MI-01 and MI-02, blind draws", level: "MEASURED", source: MI02 },
  { id: "epj-cost-range", category: "compute-economics", metric: "diffci_vs_comparator_vs_full_cpu_range", value: "4-6 / 52-77 / 59-85", unit: "CPU-s", scope: "eslint-plugin-jest, three candidates", level: "MEASURED", source: POSITION },

  // ---- Safety and prediction
  { id: "safety-measurable-total", category: "safety", metric: "mutation_recall_measurable_cases_all_corpora", value: "32 of 32", unit: "cases", scope: "cal.com 3, deepseek-harness 3, hono 20, zod 5, eslint-plugin-jest 1", level: "MEASURED", source: LEDGER, note: "a sum across corpora with different harness generations; not a reliability estimate" },
  { id: "preflight-recall", category: "safety", metric: "preflight_prevention_recall", value: "0.696", unit: "ratio", scope: "DiffCI.com own CI, 24 historical failures (16 TP, 7 FN, 1 not evaluable)", level: "MEASURED", source: PREFLIGHT },
  { id: "preflight-first-run", category: "safety", metric: "preflight_recall_first_run_rejected", value: "0.958", unit: "ratio", scope: "DiffCI.com own CI", level: "PROCESS_FACT", source: PREFLIGHT, note: "too good; a registry declaration was being counted as prediction; corrected before reporting" },
  { id: "preflight-unit-misses", category: "safety", metric: "unit_test_failures_missed", value: "9 of 9", unit: "failures", scope: "DiffCI.com own CI", level: "MEASURED", source: LEDGER },

  // ---- Reach: how many repositories DiffCI can currently reason about
  { id: "density-frame", category: "reach", metric: "frame_size", value: "40", unit: "repositories", scope: "npm most-depended-upon, ranks 1-40", level: "PROCESS_FACT", source: DENSITY },
  { id: "density-no-tsconfig", category: "reach", metric: "analyser_ineligible_no_tsconfig", value: "8", unit: "repositories", scope: "of 40", level: "MEASURED", source: DENSITY },
  { id: "density-measured", category: "reach", metric: "repositories_measured", value: "28", unit: "repositories", scope: "of 40 (3 excluded as already examined, 1 no tests discovered)", level: "MEASURED", source: DENSITY },
  { id: "density-under-20", category: "reach", metric: "repositories_with_mapping_density_under_20pct", value: "20", unit: "repositories", scope: "of 28 measured", level: "MEASURED", source: DENSITY, note: "at least two of the four mechanisms behind this band are DiffCI's own limitations" },
  { id: "density-bands", category: "reach", metric: "mapping_density_bands_80-100/60-80/40-60/20-40/0-20", value: "2 / 1 / 3 / 2 / 20", unit: "repositories", scope: "28 measured", level: "MEASURED", source: DENSITY },
  { id: "funnel-distinct", category: "reach", metric: "distinct_repositories_in_qualification_funnel", value: "32", unit: "repositories", scope: "frozen frame", level: "PROCESS_FACT", source: FUNNEL },
  { id: "funnel-unattempted", category: "reach", metric: "never_put_through_canonical_qualification", value: "17", unit: "repositories", scope: "of 32", level: "PROCESS_FACT", source: FUNNEL },
  { id: "funnel-green-twice", category: "reach", metric: "green_on_two_consecutive_runs", value: "3 of 7", unit: "repositories attempted", scope: "frozen frame", level: "MEASURED", source: FUNNEL },
  { id: "small-tsconfig-refusal", category: "reach", metric: "decisions_refused_no_tsconfig", value: "50 of 75", unit: "decisions", scope: "css-loader and eslint-config-prettier, 25 each", level: "ABSTAINED", source: SMALL },
  { id: "external-selected", category: "reach", metric: "external_targets_selected_before_inspection", value: "5", unit: "repositories", scope: "fastify, axios, date-fns, chalk, immer", level: "PROCESS_FACT", source: EXTERNAL },
  { id: "external-assessable", category: "reach", metric: "external_targets_passing_assessability_gates", value: "1 of 5", unit: "repositories", scope: "immer", level: "MEASURED", source: EXTERNAL, note: "fastify and axios: red baselines; date-fns: monorepo scope; chalk: AVA unsupported" },
  { id: "external-sign-match", category: "reach", metric: "out_of_sample_sign_predictions_confirmed", value: "1 of 1", unit: "predictions", scope: "immer", level: "MEASURED", source: EXTERNAL, note: "n = 1; validates the experiment's ordering, not a prediction accuracy rate" },
  { id: "cirep05-eslint-refused", category: "reach", metric: "ci_reproduction_outcome", value: "REFUSED", unit: "verdict", scope: "eslint/eslint, live head, no lockfile", level: "ABSTAINED", source: CIREP05, note: "reference arm ran 38,627 tests green; the engine declined to plan against an unpinned install" },
  { id: "pilot-refused", category: "reach", metric: "first_pilot_outcomes", value: "0 REPRODUCED of 4", unit: "repositories", scope: "rimraf rejected at screening; lodash, husky, chalk REFUSED", level: "ABSTAINED", source: COVERAGE },
  { id: "item1-eslint-reproduced", category: "reach", metric: "ci_reproduction_outcome_after_time_boxed_dependency_basis", value: "REPRODUCED", unit: "verdict", scope: "eslint/eslint at its pinned commit, real Node 22 container", level: "MEASURED", source: ITEM1, note: "38,647 tests in both arms, 0 failures" },
  { id: "vue-symbol", category: "reach", metric: "file_opportunity_upper_bound_from_symbol_precision", value: "19 of 183", unit: "files", scope: "vuejs/core, one changed file", level: "MEASURED", source: SYMBOL, note: "99 demonstrated, 65 unresolved; unresolved is not counted as opportunity" },

  // ---- Product boundary
  { id: "production-ci-altered", category: "product", metric: "production_ci_runs_skipped_cancelled_or_blocked", value: "0", unit: "runs", scope: "any repository, ever", level: "PROCESS_FACT", source: LEDGER },
  { id: "external-installs", category: "product", metric: "genuine_external_installs", value: "0", unit: "installs", scope: "as of 2026-09-03, direct D1 query", level: "MEASURED", source: METRICS },
  { id: "own-ci-tests", category: "product", metric: "own_test_suite_size", value: "1960", unit: "tests", scope: "DiffCI.com, 389 suites, 0 failures", level: "MEASURED", source: LEDGER },
  { id: "own-ci-cost", category: "product", metric: "own_ci_cost_per_job", value: "0.0048 to 0.0127", unit: "USD", scope: "10 most recent real jobs on main, Cloudflare containers", level: "MEASURED", source: LEDGER },
  { id: "own-ci-wall", category: "product", metric: "own_ci_wall_time", value: "135 to 354", unit: "seconds", scope: "same 10 jobs", level: "MEASURED", source: LEDGER },
];

const f = (id: string): Figure => {
  const found = figures.find((x) => x.id === id);
  if (!found) throw new Error(`unknown figure id: ${id}`);
  return found;
};

const stage0RepositoryRows: readonly TableRow[] = [
  ["TanStack/query", "12%", "64", "84.2%"],
  ["axios/axios", "33%", "44", "56.1%"],
  ["colinhacks/zod", "6%", "83", "41.8%"],
  ["date-fns/date-fns", "100%", "0", "-8.7%"],
  ["honojs/hono", "19%", "81", "61.5%"],
  ["mikro-orm/mikro-orm", "100%", "0", "-8.7%"],
  ["nestjs/nest", "100%", "0", "-2.0%"],
  ["pmndrs/jotai", "41%", "48", "24.1%"],
  ["pmndrs/valtio", "45%", "41", "36.6%"],
  ["pmndrs/zustand", "32%", "18", "25.5%"],
  ["redis/ioredis", "47%", "46", "49.2%"],
  ["sindresorhus/execa", "100%", "0", "n/a"],
  ["sindresorhus/ky", "12%", "0", "n/a"],
  ["trpc/trpc", "100%", "0", "-13.6%"],
  ["typeorm/typeorm", "100%", "0", "-9.9%"],
  ["unjs/defu", "79%", "14", "7.5%"],
  ["unjs/h3", "13%", "67", "25.0%"],
  ["unjs/ofetch", "64%", "27", "6.6%"],
  ["unjs/unstorage", "55%", "32", "25.3%"],
  ["unocss/unocss", "100%", "0", "-4.2%"],
];

export const diffciOpenEvidenceStudy2026: StudyFindings = {
  studyId: "diffci-oes-2026-v1",
  studyName: "DiffCI Open Evidence Study 2026",
  subtitle: "What change-aware test selection is actually worth on real open-source CI, measured, including where it is worth nothing",
  version: "v1",
  asOf: "2026-09-03",
  updatedAsOf: "2026-09-25",
  windowStart: "2026-08-19",
  windowEnd: "2026-09-03",
  publisher: "DiffCI",
  pagePath: "research/diffci-open-evidence-2026",
  downloadDir: "research/2026",
  license: { name: "Creative Commons Attribution 4.0 International (CC BY 4.0)", url: "https://creativecommons.org/licenses/by/4.0/" },
  disclaimer:
    "Every repository named in this study is a public open-source project with public CI, analysed from its public source and replayed in DiffCI's own sandbox. None of them is a DiffCI customer, partner or user. None has installed DiffCI, been contacted about it, or endorsed anything here. No change was ever proposed to, or made in, any of their real CI pipelines.",
  lede:
    "Between 19 August and 3 September 2026, DiffCI ran a sequence of pre-registered experiments to answer one question: on real repositories, how much CI work can a dependency-graph test selector safely skip, and is that worth more than a trivial path rule? This study publishes every number those experiments produced, including the ones that argue against the product.",
  headlineFindings: [
    { id: "deltas", value: "2,000", label: "real commit deltas across 20 repositories, historically replayed" },
    { id: "opportunity", value: "29.8%", label: "of deltas offered any chance to be selective at all" },
    { id: "win-rate", value: "94.3%", label: "of those chances DiffCI selected fewer tests than a path rule; the path rule won 0" },
    { id: "aggregate", value: "4.2%", label: "aggregate test reduction against the path rule across the whole corpus" },
    { id: "recall", value: "96.4% vs 70.7%", label: "job-level recall of 280 real historical CI failures, DiffCI vs path rule" },
    { id: "executed", value: "44% and 90%", label: "job-level reduction on the two repositories where selections were actually executed and timed" },
    { id: "false-greens", value: "0 of 32", label: "false greens across every measurable mutation, in five corpora" },
    { id: "altered", value: "0", label: "production CI runs ever skipped, cancelled or blocked" },
  ],
  sections: [
    {
      id: "where-the-advantage-lives",
      title: "The advantage is real, narrow, and concentrated in small repositories",
      paragraphs: [
        "The largest experiment replayed 2,000 real commit deltas, 100 each from 20 repositories chosen for structural diversity before any were run, through a real Cloudflare orchestrator. Each delta was classified, independently of DiffCI's own output, by whether a selective decision was even possible: <strong>60.3%</strong> touched a lockfile, workflow or root configuration and fell back to full CI by rule; <strong>9.9%</strong> were already optimally handled by a plain path rule; <strong>29.8%</strong> offered a genuine discriminative opportunity.",
        "Within those 565 opportunities, DiffCI selected fewer tests than the path rule on <strong>94.3%</strong>, tied on the rest, and lost on none. The median reduction against the path rule inside that bucket was <strong>95.0%</strong>.",
        "Across the whole corpus, weighted by test count, that collapses to a <strong>4.2%</strong> aggregate reduction against the path rule. The unconditional median task reduction was <strong>0.0%</strong>. Seven of the twenty repositories hit 100% mandatory fallback or unsafe graph confidence and contributed nothing but drag. A repository-clustered bootstrap puts the 95% interval on the aggregate at <strong>-4.8% to +47.9%</strong>, which crosses zero: this sample cannot rule out a null population effect.",
        "The clearest correlate was repository size. The ten repositories below the median source-file count showed a <strong>44.9%</strong> aggregate reduction; the nine above it showed <strong>-0.95%</strong>, indistinguishable from zero. Size and fallback rate are confounded in a sample this small, and the report says so.",
      ],
      charts: [
        {
          id: "stage0-classification",
          title: "Three-way classification of the 1,899 analysed commit deltas",
          kind: "stacked-single",
          unit: "%",
          caption:
            "Stage 0. A delta is a mandatory fallback when it touches a lockfile, a workflow file or root configuration, so no selector may skip anything. It is path-rule-optimal when the cheap comparator already selects the minimum. Only the remaining 29.8% offered any chance to be selective.",
          data: [
            { label: "Mandatory fallback (lockfile, workflow, root config)", value: 60.3, note: "1,146 deltas", figure: "stage0-bucket-fallback", tone: "neutral" },
            { label: "Path rule already optimal", value: 9.9, note: "188 deltas", figure: "stage0-bucket-optimal", tone: "setup" },
            { label: "Genuine discriminative opportunity", value: 29.8, note: "565 deltas", figure: "stage0-bucket-opportunity", tone: "tests" },
          ],
        },
        {
          id: "stage0-conditional-vs-corpus",
          title: "Conditional win rate versus whole-corpus effect",
          kind: "bars",
          unit: "%",
          max: 100,
          caption:
            "Stage 0. The first bar is a win rate: how often DiffCI selected fewer tests than the path rule where that was possible at all. The second is the test-count-weighted aggregate reduction across every analysed delta, most of which offered no opportunity. Both are true; the second is the one that matters for a bill.",
          data: [
            { label: "Win rate within the 565 discriminative opportunities", value: 94.3, note: "5.7% tied, 0% lost", figure: "stage0-win-rate" },
            { label: "Aggregate reduction across the whole corpus", value: 4.2, note: "95% bootstrap interval -4.8% to +47.9%", figure: "stage0-agg-vs-path" },
          ],
        },
        {
          id: "stage0-per-repository",
          title: "Aggregate test reduction against the path rule, per repository",
          kind: "diverging-bars",
          unit: "%",
          caption: "Stage 0, 100 deltas per repository, test-count weighted. Negative values are repositories where 100%-fallback deltas selected the full suite while the path rule had already narrowed. execa and ky are omitted: execa's path rule selected nothing, and ky's AVA test counts are unreliable.",
          data: [
            { label: "TanStack/query", value: 84.2 },
            { label: "honojs/hono", value: 61.5 },
            { label: "axios/axios", value: 56.1 },
            { label: "redis/ioredis", value: 49.2 },
            { label: "colinhacks/zod", value: 41.8 },
            { label: "pmndrs/valtio", value: 36.6 },
            { label: "pmndrs/zustand", value: 25.5 },
            { label: "unjs/unstorage", value: 25.3 },
            { label: "unjs/h3", value: 25.0 },
            { label: "pmndrs/jotai", value: 24.1 },
            { label: "unjs/defu", value: 7.5 },
            { label: "unjs/ofetch", value: 6.6 },
            { label: "nestjs/nest", value: -2.0, note: "100% fallback" },
            { label: "unocss/unocss", value: -4.2, note: "100% fallback" },
            { label: "date-fns/date-fns", value: -8.7, note: "100% fallback" },
            { label: "mikro-orm/mikro-orm", value: -8.7, note: "100% fallback" },
            { label: "typeorm/typeorm", value: -9.9, note: "100% fallback" },
            { label: "trpc/trpc", value: -13.6, note: "100% fallback" },
          ],
        },
      ],
      tables: [
        {
          id: "stage0-repositories",
          caption: "Stage 0 per-repository results. Fallback rate is the share of the 100 deltas that fell back to full CI by rule or by unsafe graph confidence.",
          columns: ["Repository", "Fallback rate", "Discriminative opportunities", "Aggregate reduction vs path rule"],
          numericColumns: [1, 2, 3],
          rows: stage0RepositoryRows,
        },
      ],
    },
    {
      id: "safety-at-scale",
      title: "Safety held at scale, and it was not perfect",
      paragraphs: [
        "Using authenticated GitHub Actions history, the same 2,000 deltas yielded <strong>280</strong> real job-level CI failures across 154 deltas. DiffCI's plan would have missed <strong>10</strong> of them; the path rule would have missed <strong>82</strong>. That is a job-level failure recall of <strong>96.4%</strong> against <strong>70.7%</strong>. Ten misses is a real finding. Earlier partial snapshots had suggested zero, and the final report refused to round to it.",
        "Where a regression could be manufactured and measured, the record is cleaner. Across five corpora, every mutation whose detection was measurable was detected: <strong>32 of 32</strong>, with zero false greens. That sum spans different harness generations and is not a reliability estimate. Twenty-five of the cases come from the canonical Linux container on hono and zod, whose frozen bundle prints its own caveat that 25 cases cannot support a rate.",
        "The one place DiffCI's prediction was honestly weak is its own repository. A pre-flight predictor replayed leakage-safe against 24 historical failures in DiffCI's own CI scored a prevention recall of <strong>0.696</strong>, and missed all nine unit-test failures in the set. The first run had scored 0.958, was investigated because it was too good, and turned out to be counting a registry declaration as a prediction.",
      ],
      charts: [
        {
          id: "stage0-recall",
          title: "Job-level recall of 280 real historical CI failures",
          kind: "bars",
          unit: "%",
          max: 100,
          caption:
            "Stage 0, authenticated GitHub Actions history for the same 2,000 deltas. Recall is the share of real failed jobs whose failing tests the plan would still have run. DiffCI's 10 misses are real and are listed in the source report; this is not a safety guarantee.",
          data: [
            { label: "DiffCI", value: 96.4, note: "10 of 280 missed", figure: "stage0-diffci-recall" },
            { label: "Path rule", value: 70.7, note: "82 of 280 missed", figure: "stage0-path-recall" },
          ],
        },
      ],
      tables: [
        {
          id: "mutation-recall",
          caption: "Measurable mutation cases by corpus. A case is measurable only if reverting the change fails the full suite; unmeasurable cases are counted and named in the source reports, never folded into the denominator.",
          columns: ["Corpus", "Environment", "Measurable cases detected", "False greens"],
          numericColumns: [2, 3],
          rows: [
            ["cal.com", "DiffCI sandbox", "3 of 3", "0"],
            ["deepseek-ai/deepseek-harness", "DiffCI sandbox", "3 of 3", "0"],
            ["honojs/hono", "canonical Linux container", "20 of 20", "0"],
            ["colinhacks/zod", "canonical Linux container", "5 of 5", "0"],
            ["jest-community/eslint-plugin-jest", "canonical Linux container, sealed target", "1 of 1", "0"],
          ],
        },
      ],
    },
    {
      id: "executed-not-computed",
      title: "When the selection is executed, install cost decides the number",
      paragraphs: [
        "A computed selection is a claim. On two repositories the claim was tested: the full test suite and DiffCI's selected subset were both actually run and timed at the same commit, ten merges in total, and a runtime invariant checked whether the test runner honoured the selection instead of quietly broadening it. It did on <strong>12 of 13</strong> executions; the thirteenth was withheld rather than counted.",
        "On cal.com, five merges chosen by a rule written down before their costs were known produced a test-stage reduction of <strong>86.0% to 91.6%</strong>. Measured against the whole job, one merge came to <strong>44.2%</strong>, because cal.com spends 319.7 seconds on install and 17.1 on <code>prisma generate</code> before a single test runs, and those are paid identically on both paths. On deepseek-harness, whose install takes 23 to 39 seconds, the same selection quality produced <strong>79.5% to 89.5%</strong> at job level.",
        "That forty-point gap between the two repositories has nothing to do with how good the selection was. It is entirely the ratio of install to test. Anyone quoting a single industry percentage has not measured the repository in question.",
      ],
      tables: [
        {
          id: "executed-replays",
          caption: "Both paths executed and timed in DiffCI's sandbox. Net figures subtract DiffCI's own analysis cost. deepseek-harness carries 16 to 18 pre-existing failures on every run; a naive check would have read that as a caught regression every time, and the harness was fixed before it could.",
          columns: ["Repository", "Merges executed", "Test-stage reduction, net", "Job-level reduction, net", "Selection honoured", "Measurable regressions caught"],
          numericColumns: [1, 2, 3, 4, 5],
          rows: [
            ["cal.com", "6", "86.0% to 91.6%", "44.2%", "8 of 8", "3 of 3"],
            ["deepseek-ai/deepseek-harness", "4 of 5", "83.5% to 94.3%", "79.5% to 89.5%", "3 exact, 1 framework-expanded, 1 withheld", "3 of 3"],
          ],
        },
      ],
    },
    {
      id: "against-a-path-rule",
      title: "Against a cheap path rule, DiffCI sometimes loses",
      paragraphs: [
        "Beating the full suite is a soft target. The business question is whether DiffCI's analysis pays for itself against a path rule that costs nothing to compute. Every CPU-second of DiffCI's own analysis is charged to DiffCI; the comparator is charged nothing, even though it reads the same graph.",
        "On honojs/hono, measured in the canonical container across 22 candidates, DiffCI's gross saving against the full suite was <strong>+1,408.92 CPU-s</strong> and its incremental result against the path rule was <strong>-80.90 CPU-s</strong>: 4 candidates positive, 18 negative. Wherever the path rule was tight, DiffCI lost; every one of the four wins was a case where the path rule blew up to 123 tests and DiffCI held at 83. DiffCI paid a fixed toll of roughly 3.3 CPU-s per candidate to insure against that, and on hono the insurance cost more than it saved. Test counts had predicted this, with 12 of 20 selections classed as over-broad, and the CPU meter agreed. A meter that reported DiffCI winning everywhere would have indicted itself.",
        "On colinhacks/zod the sign flipped: across five confirmed cases DiffCI selected <strong>629</strong> tests where the path rule selected 761 and the full suite held 967, with four of five selections classed efficient. On jest-community/eslint-plugin-jest, three candidates drawn blind under pre-committed rules cost DiffCI 4 to 6 CPU-s where the comparator cost 52 to 77 and the full suite 59 to 85, an incremental result of <strong>+71.48, +43.81 and +53.56 CPU-s</strong>.",
        "The one out-of-sample test of the economic predictor was immerjs/immer, selected by a third party before any DiffCI data existed. The rule, frozen beforehand, predicted a positive sign; the measurement was <strong>+46.97 CPU-s</strong>, positive. That is n = 1, and it validates the ordering of the experiment rather than a prediction accuracy rate. The magnitude was not validated: on a matched subset the model had predicted +85.19, and the gap exposed that the linear per-file cost model under-prices 1- and 2-file selections by roughly four times, an error whose direction inflates predicted savings.",
      ],
      charts: [
        {
          id: "compute-economics-chart",
          title: "Incremental CPU-seconds against the free path-rule comparator",
          kind: "diverging-bars",
          unit: " CPU-s",
          decimals: 2,
          legend: { positive: "DiffCI's analysis paid for itself against the path rule", negative: "DiffCI cost more than the path rule" },
          caption:
            "Comparator cost minus DiffCI's selected-run cost minus DiffCI's own analysis cost, per candidate set. honojs/hono is 22 candidates in the canonical container; immerjs/immer is 7 measured candidates; the three eslint-plugin-jest rows are single sealed-target candidates. Same numbers as the table below.",
          data: [
            { label: "eslint-plugin-jest GEN-C", value: 71.48, figure: "genc-incremental", note: "GENERATION_C_01 sealed target" },
            { label: "eslint-plugin-jest MI-02", value: 53.56, figure: "mi02-incremental", note: "recall unmeasurable" },
            { label: "immerjs/immer", value: 46.97, figure: "immer-measured", note: "7 measured candidates" },
            { label: "eslint-plugin-jest MI-01", value: 43.81, figure: "mi01-incremental", note: "recall unmeasurable" },
            { label: "honojs/hono", value: -80.9, figure: "hono-incremental", note: "22 candidates, 4 positive and 18 negative" },
          ],
        },
      ],
      tables: [
        {
          id: "compute-economics",
          caption: "All values in CPU-seconds. Incremental CPU is comparator cost minus DiffCI's selected-run cost minus DiffCI's analysis cost. Positive means DiffCI's intelligence paid for itself against a free path rule; negative means it did not. All in the canonical Linux container (cloudflare/sandbox:0.12.5, Node 22). Blank cells are per-arm figures the source summary does not restate; across the three eslint-plugin-jest candidates the full suite cost 59 to 85, the path rule 52 to 77 and DiffCI 4 to 6.",
          columns: ["Repository", "Candidates", "Full suite", "Path rule", "DiffCI incl. analysis", "Incremental vs path rule"],
          numericColumns: [1, 2, 3, 4, 5],
          rows: [
            ["honojs/hono", "22", "1,928.94", "439.12", "520.02", "-80.90"],
            ["immerjs/immer", "7 measured", "79.02", "79.51", "32.54", "+46.97"],
            ["eslint-plugin-jest, GENERATION_C_01", "1", "", "", "", "+71.48"],
            ["eslint-plugin-jest, MI-01", "1", "", "", "", "+43.81"],
            ["eslint-plugin-jest, MI-02", "1", "64.30", "59.88", "6.32", "+53.56"],
          ],
        },
      ],
    },
    {
      id: "graph-causality",
      title: "The dependency graph has reached tests the diff could not name, but it has not been shown to be necessary",
      paragraphs: [
        "On the one blind-drawn candidate where detection, graph contribution and economics were all measurable at once, DiffCI selected 2 files of 174 against the path rule's 164, caught the regression, and saved 71.48 CPU-s. Both selected files were files the commit had changed. <strong>Nothing was reached through the graph.</strong> A rule that runs only the files a commit touched would have produced the identical selection, detection and cost.",
        "On two other candidates, drawn independently under a different rule, DiffCI did reach a test file the commit had not touched, through the import graph, selecting 2 of 159 against the path rule's 149. On both, detection was unmeasurable because reverting the change did not fail the full suite. So the evidence ladder closes with one measured safety-plus-savings result, two independent demonstrations of graph reach, and no case where both were measured together.",
        "The consequence is written into the project's standard: beating the full suite no longer counts, and beating the path rule is necessary but not sufficient. Any claim that the graph earns its compute must beat a direct-only rule, the cheap heuristic that has tied twice.",
      ],
    },
    {
      id: "how-far-it-reaches",
      title: "Most repositories cannot yet be reached at all",
      paragraphs: [
        "The narrowest finding in the study is how few repositories DiffCI can currently reason about. Of npm's 40 most-depended-upon packages, <strong>8</strong> have no <code>tsconfig.json</code> and are refused before any graph is built. Of the 28 that could be measured, <strong>20</strong> have a mapping density under 20%: fewer than one test file in five can reach any production file through the static import graph. At least two of the four mechanisms behind that band are DiffCI's own limitations, unresolved workspace self-references and monorepo scope, and the report declines to blame the repositories for them.",
        "Canonical qualification, which requires a repository's suite to go green twice in the reference container before any selection evidence counts, has been attempted on only 7 of 32 repositories in the frozen frame: 3 went green twice. Seventeen have never been attempted. The funnel's honest headline is how little is known, not a green rate.",
        "The external-validation sequence made this concrete. Five repositories were selected by a third party before any DiffCI inspection: <strong>1 of 5</strong> passed the pre-registered assessability gates. Fastify and Axios had red baselines; date-fns could not have its monorepo scope preserved; Chalk uses AVA, which is unsupported. Only immer was assessable.",
        "The product's CI-reproduction engine, which must reconstruct a repository's real pipeline before it may plan against it, refused on first exposure to eslint/eslint because the repository commits no lockfile and runs a bare <code>npm install</code>. The refusal was correct on the facts: the reference arm ran 38,627 tests green, and the engine still declined to claim it could account for an unpinned install. The first mechanically selected pilot of four further repositories reproduced <strong>none</strong>: rimraf was rejected at screening, lodash, husky and chalk were refused for three distinct coverage gaps. A weaker, distinctly labelled time-boxed dependency basis built afterwards took eslint at its pinned commit to REPRODUCED, 38,647 tests in both arms, while still failing loudly on the live head that had drifted past the cutoff.",
      ],
      tables: [
        {
          id: "reach-funnel",
          caption: "Where repositories stop. Each row is a different gate; they are not a single funnel and the denominators differ.",
          columns: ["Gate", "Outcome", "Source"],
          numericColumns: [],
          rows: [
            ["No tsconfig.json in the tree", "8 of 40 refused before analysis", "mapping-density survey"],
            ["Static import graph connects tests to production", "20 of 28 measured under 20% mapping density", "mapping-density survey"],
            ["Suite green twice in the canonical container", "3 of 7 attempted; 17 of 32 never attempted", "qualification funnel"],
            ["Pre-registered external assessability gates", "1 of 5 passed", "external validation #1"],
            ["CI pipeline reproduced from real configuration", "0 of 4 in the first pilot; eslint REFUSED then REPRODUCED under a time-boxed basis", "engine coverage baseline"],
          ],
        },
      ],
    },
    {
      id: "methodology",
      title: "Methodology and research integrity",
      paragraphs: [
        "Every experiment in this study was pre-registered: the methodology, corpus, thresholds or prediction was committed to the repository, and in the larger cases SHA-256 hashed, before the run that would be graded against it. Stage 0's methodology was frozen at one commit across 13 files; the 24-hour shadow-ramp gate was declared before the repositories it governed were enrolled; the immer economic prediction was committed before any economics arm ran; the GENERATION_C target was sealed before any DiffCI output existed.",
        "Measurements that matter were made in one canonical environment, a Cloudflare sandbox container (cloudflare/sandbox:0.12.5, Ubuntu 22.04.5, Node 22.23.2), with the agent's exact tarball bytes verified in-container before anything was measured, and results frozen as checksummed bundles before interpretation. Developer-host evidence is labelled as such and was not used for CPU, wall time or economics.",
        "Where DiffCI could not measure, it abstained: results are reported as UNMEASURABLE, REFUSED or withheld, never estimated into the denominator. Where the process went wrong, the correction is recorded next to the original rather than edited over it.",
      ],
      bullets: [
        "One Stage 0 delta with an impossible count was excluded from aggregates rather than patched mid-benchmark on an unconfirmed root cause.",
        "The pre-flight replay's first result of 0.958 was rejected as too good, the counting defect was found, and 0.696 was reported.",
        "The qualification-funnel script initially reported 12 analyser-ineligible repositories; a classification defect was fixed and 8 reported.",
        "GENERATION_C_01's corpus row reports one graph-derived selection; the row was left unedited and re-read on the page as 0 graph-derived, 2 directly changed.",
        "A mocha output parser was found to have been validated against a hand-typed fixture instead of real ANSI-wrapped output; the regression test now uses the captured bytes.",
        "A cost figure that had been transcribed as $0.0044 in one place and $0.0045 in another was re-measured rather than reconciled by choosing one.",
      ],
    },
  ],
  notEstablished: [
    "That the dependency graph is causally necessary for detection. On the one case where both were measured, a changed-files rule would have tied.",
    "Any savings in anyone's production CI. Nothing has ever been skipped in a real pipeline; every reduction here is a controlled replay in DiffCI's sandbox with both paths executed.",
    "A general prediction accuracy rate for the economic predictor. One out-of-sample sign match is n = 1.",
    "How often the predictor can be reached. 1 of 5 externally selected repositories was assessable; that is a signal, not a population estimate.",
    "A false-green rate. 32 measurable cases with 0 misses is a count, not a reliability estimate.",
    "That DiffCI is cheaper than a path rule in general. It lost on hono, won on zod, immer and eslint-plugin-jest, and has not been measured on enough repositories to say.",
    "Anything about repositories outside TypeScript and JavaScript, or without a tsconfig.json. They are refused, not measured.",
    "Any customer, user, pilot or revenue. As of 3 September 2026 there were zero external installs, confirmed by direct database query.",
  ],
  figures,
  sourceReports: [
    { path: STAGE0, what: "Stage 0 final report: 20 repositories, 2,000 deltas, opportunity buckets, safety recall, overhead" },
    { path: CALCOM_11, what: "cal.com complete-job savings and stage timings for PR #29940" },
    { path: CALCOM_13, what: "cal.com five predeclared merges, executed and timed" },
    { path: DEEPSEEK_07, what: "deepseek-harness per-merge execution and economics" },
    { path: DEEPSEEK_09, what: "Aggregate and cross-repository comparison, mutation recall, selection honouring" },
    { path: ECON, what: "Compute economics against the path-rule comparator: hono" },
    { path: SAFETY, what: "Safety-validation phase close: 25 canonical cases, hono and zod" },
    { path: HONO_XENV, what: "hono cross-environment reproduction, 13 of 13" },
    { path: EXTERNAL, what: "External validation #1 frozen conclusion: five targets, immer" },
    { path: IMMER_PRED, what: "immer economic prediction, frozen before measurement" },
    { path: GENC, what: "GENERATION_C_01 sealed-target observation" },
    { path: MI02, what: "MECHANISM_ISOLATION_02 and the close of the mechanism line" },
    { path: POSITION, what: "The claim as of 2026-09-01 and the direct-only baseline standard" },
    { path: DENSITY, what: "Test-to-production mapping density across the frozen 40" },
    { path: FUNNEL, what: "Canonical qualification funnel" },
    { path: SMALL, what: "tsconfig.json refusals on the three small repositories" },
    { path: CIREP05, what: "CI_REPRODUCTION_05: eslint REFUSED, correctly" },
    { path: COVERAGE, what: "ENGINE_COVERAGE_01 baseline: the first pilot's four outcomes" },
    { path: ITEM1, what: "Time-boxed dependency basis: eslint REPRODUCED at its pinned commit" },
    { path: SYMBOL, what: "vue symbol-precision diagnostic" },
    { path: PREFLIGHT, what: "Pre-flight P1 leakage-safe replay on DiffCI's own CI" },
    { path: LEDGER, what: "Website evidence ledger: every published number and its level" },
    { path: METRICS, what: "YC sprint metrics: zero external installs, verified by query" },
  ],
  // Founder decision 2026-09-03: the study page is the only citable artefact; the contributed
  // article is not hosted on the site (its draft lives in docs/website/05-editorial-path-rule.md).
  companionDocuments: [],
};
