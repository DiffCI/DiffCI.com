/**
 * The monthly savings ledger (Phase 04, 2026-08-26).
 *
 * One month, one organization, one row per repository, and a verdict per row that a person can act on
 * without reading the code that produced it. The exit criterion for this phase is "one month of MEASURED
 * net savings + one honest zero" - and the second half is the harder one to build, because a system that
 * cannot say "this repository saved you nothing" will eventually say something false about one that did.
 *
 * So a row's verdict is one of four, and three of them are not a saving:
 *
 *   NO_DATA           nothing arrived, or nothing that could be compared. Says nothing either way.
 *   NO_OPPORTUNITY    observations arrived and the net was zero. The honest zero. Not a failure - most
 *                     commits on most repositories genuinely have nothing to skip.
 *   NET_NEGATIVE      the simple path-rule comparator would have run LESS than DiffCI. Reported as
 *                     plainly as a positive, because Phase 01 measured exactly this on real repositories.
 *   NET_POSITIVE      DiffCI would have run less than the comparator, by a counted number of tests.
 *
 * BILLABILITY IS SEPARATE FROM POSITIVITY, and always false today. A net-positive month is a real
 * measured count of avoided tests; it is not an invoice, because an invoice needs money, money needs
 * duration, and duration on the selected side is never measured while DiffCI only observes. Every row
 * therefore carries `billable: false` and the reason - Phase 05 will need that reason to disappear for a
 * real cause, not to be deleted.
 */
import type { ObservationRecord } from "../ingest/types.js";
import type { EvidenceTier } from "../usage/economics-classification.js";
import type { ValueWithConfidence } from "../usage/savings.js";
import { computeNetSavings, type NetSavingsInput, type ObservationNetSavings } from "./net-savings.js";

export type LedgerVerdict = "NO_DATA" | "NO_OPPORTUNITY" | "NET_NEGATIVE" | "NET_POSITIVE";

export interface LedgerRow {
  repositoryId: string;
  /** "owner/name" when the caller supplied it; the ledger itself never looks a repository up. */
  ownerName?: string;
  verdict: LedgerVerdict;

  observations: number;
  /** Observations that produced a usable net figure. The denominator for everything below. */
  comparable: number;
  /** Observations that arrived but could not be compared, and the reasons, deduplicated. */
  notComparable: number;
  notComparableReasons: string[];

  /** Sum over comparable observations. MEASURED - these are counted tests, not modelled ones. */
  netTestsAvoided: number;
  /** Same sum measured against running the whole suite. Always >= netTestsAvoided; shown so the gap
   * between the honest comparator and the flattering one is visible rather than a matter of trust. */
  grossTestsAvoidedVsFullSuite: number;
  /** How many comparable observations were individually net-negative. */
  netNegativeObservations: number;
  countTier: EvidenceTier;

  netComputeSecondsAvoided: ValueWithConfidence<number>;
  netCostAvoidedUsd: ValueWithConfidence<number>;
  timeTier: EvidenceTier;

  /** Always false today. See the file header. */
  billable: false;
  notBillableReason: string;
}

export interface MonthlyLedger {
  organizationId: string;
  /** "YYYY-MM", UTC. */
  month: string;
  from: string;
  to: string;
  rows: LedgerRow[];
  totals: {
    repositories: number;
    observations: number;
    comparable: number;
    netTestsAvoided: number;
    grossTestsAvoidedVsFullSuite: number;
    countTier: EvidenceTier;
    netComputeSecondsAvoided: ValueWithConfidence<number>;
    netCostAvoidedUsd: ValueWithConfidence<number>;
    timeTier: EvidenceTier;
    billable: false;
    notBillableReason: string;
  };
}

const NOT_BILLABLE_REASON =
  "net savings are a MEASURED count of avoided tests, not a measured amount of time or money: DiffCI is observation-only, so the selected side is never executed and its duration is never measured. Nothing may be invoiced from this figure.";

const UNKNOWN: ValueWithConfidence<number> = { value: "unknown", confidence: "unavailable" };

/** UTC month bounds. `month` is "YYYY-MM"; anything else throws rather than silently picking a range. */
export function monthBounds(month: string): { from: string; to: string } {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) throw new Error(`month must be "YYYY-MM", got "${month}"`);
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) throw new Error(`month must be 01-12, got "${month}"`);
  const from = new Date(Date.UTC(year, monthIndex, 1));
  const to = new Date(Date.UTC(monthIndex === 11 ? year + 1 : year, (monthIndex + 1) % 12, 1));
  return { from: from.toISOString(), to: to.toISOString() };
}

function weakerTier(a: EvidenceTier, b: EvidenceTier): EvidenceTier {
  const rank: Record<EvidenceTier, number> = { MEASURED: 2, ESTIMATED: 1, UNKNOWN: 0 };
  return rank[a] <= rank[b] ? a : b;
}

function sumConfident(values: ValueWithConfidence<number>[]): ValueWithConfidence<number> {
  const usable = values.filter((entry) => typeof entry.value === "number");
  if (usable.length === 0 || usable.length !== values.length) return UNKNOWN;
  // Weakest-wins, the same rule aggregateSavings uses: a total is never more certain than its least
  // certain contributor, and a partially-unknown total is unknown rather than a subtotal in disguise.
  const confidence = usable.reduce<ValueWithConfidence<number>["confidence"]>(
    (weakest, entry) => (entry.confidence === "unavailable" || weakest === "unavailable" ? "unavailable" : entry.confidence === "count_based_estimate" || weakest === "count_based_estimate" ? "count_based_estimate" : entry.confidence),
    usable[0]!.confidence,
  );
  return { value: usable.reduce((sum, entry) => sum + (entry.value as number), 0), confidence };
}

export interface BuildLedgerInput {
  organizationId: string;
  month: string;
  observations: ObservationRecord[];
  /** Display names, keyed by repository id. Absent names are simply not shown. */
  repositoryNames?: Map<string, string>;
  /** Per-repository duration assumptions. A repository absent here keeps UNKNOWN time and cost. */
  savingsInput?: (repositoryId: string) => NetSavingsInput;
}

function verdictFor(comparable: number, netTestsAvoided: number): LedgerVerdict {
  if (comparable === 0) return "NO_DATA";
  if (netTestsAvoided > 0) return "NET_POSITIVE";
  if (netTestsAvoided < 0) return "NET_NEGATIVE";
  return "NO_OPPORTUNITY";
}

function buildRow(repositoryId: string, ownerName: string | undefined, entries: ObservationNetSavings[]): LedgerRow {
  const comparable = entries.filter((entry) => entry.comparable);
  const notComparable = entries.filter((entry) => !entry.comparable);
  const netTestsAvoided = comparable.reduce((sum, entry) => sum + (entry.netTestsAvoided ?? 0), 0);
  const gross = comparable.reduce((sum, entry) => sum + (entry.grossTestsAvoidedVsFullSuite ?? 0), 0);
  const timeTier = comparable.length === 0 ? "UNKNOWN" : comparable.map((entry) => entry.timeTier).reduce(weakerTier, "MEASURED");

  return {
    repositoryId,
    ownerName,
    verdict: verdictFor(comparable.length, netTestsAvoided),
    observations: entries.length,
    comparable: comparable.length,
    notComparable: notComparable.length,
    notComparableReasons: Array.from(new Set(notComparable.map((entry) => entry.notComparableReason ?? "unknown"))),
    netTestsAvoided,
    grossTestsAvoidedVsFullSuite: gross,
    netNegativeObservations: comparable.filter((entry) => (entry.netTestsAvoided ?? 0) < 0).length,
    countTier: comparable.length === 0 ? "UNKNOWN" : "MEASURED",
    netComputeSecondsAvoided: comparable.length === 0 ? UNKNOWN : sumConfident(comparable.map((entry) => entry.netComputeSecondsAvoided)),
    netCostAvoidedUsd: comparable.length === 0 ? UNKNOWN : sumConfident(comparable.map((entry) => entry.netCostAvoidedUsd)),
    timeTier,
    billable: false,
    notBillableReason: NOT_BILLABLE_REASON,
  };
}

/**
 * Builds the month. Observations outside the month are ignored rather than clamped in - a ledger whose
 * boundaries move with the data is not a ledger.
 */
export function buildMonthlyLedger(input: BuildLedgerInput): MonthlyLedger {
  const { from, to } = monthBounds(input.month);
  const inMonth = input.observations.filter((observation) => observation.receivedAt >= from && observation.receivedAt < to);

  const byRepository = new Map<string, ObservationNetSavings[]>();
  for (const observation of inMonth) {
    const savingsInput = input.savingsInput?.(observation.repositoryId) ?? {};
    const entry = computeNetSavings(observation, savingsInput);
    const bucket = byRepository.get(observation.repositoryId) ?? [];
    bucket.push(entry);
    byRepository.set(observation.repositoryId, bucket);
  }

  const rows = Array.from(byRepository.entries())
    .map(([repositoryId, entries]) => buildRow(repositoryId, input.repositoryNames?.get(repositoryId), entries))
    // Largest net saving first, but net-negative rows sort to the top of the tail rather than the
    // bottom of the list: a month with bad news should not need scrolling to find it.
    .sort((a, b) => (a.verdict === "NET_NEGATIVE" && b.verdict !== "NET_NEGATIVE" ? -1 : b.verdict === "NET_NEGATIVE" && a.verdict !== "NET_NEGATIVE" ? 1 : b.netTestsAvoided - a.netTestsAvoided));

  const comparableRows = rows.filter((row) => row.comparable > 0);
  return {
    organizationId: input.organizationId,
    month: input.month,
    from,
    to,
    rows,
    totals: {
      repositories: rows.length,
      observations: inMonth.length,
      comparable: rows.reduce((sum, row) => sum + row.comparable, 0),
      netTestsAvoided: rows.reduce((sum, row) => sum + row.netTestsAvoided, 0),
      grossTestsAvoidedVsFullSuite: rows.reduce((sum, row) => sum + row.grossTestsAvoidedVsFullSuite, 0),
      countTier: comparableRows.length === 0 ? "UNKNOWN" : "MEASURED",
      netComputeSecondsAvoided: comparableRows.length === 0 ? UNKNOWN : sumConfident(comparableRows.map((row) => row.netComputeSecondsAvoided)),
      netCostAvoidedUsd: comparableRows.length === 0 ? UNKNOWN : sumConfident(comparableRows.map((row) => row.netCostAvoidedUsd)),
      timeTier: comparableRows.length === 0 ? "UNKNOWN" : comparableRows.map((row) => row.timeTier).reduce(weakerTier, "MEASURED"),
      billable: false,
      notBillableReason: NOT_BILLABLE_REASON,
    },
  };
}
