/**
 * Compares two mutation runs of the same corpus at CANDIDATE level (2026-08-29).
 *
 * WHY NOT JUST COMPARE FUNNELS. Two runs can report the identical funnel - same measurable count, same
 * confirmed count, same zero false greens - while disagreeing about which commits were measurable and
 * which mutation was applied to each. Aggregate agreement would then be reported as reproduction when
 * the underlying evidence had moved. The funnel is a summary; the per-candidate mapping is the claim.
 *
 *   commit + mutation identity -> host classification -> canonical-environment classification
 *
 * MUTATION IDENTITY IS PART OF THE KEY. `dogfood-mutate` iterates a commit's changed source files until
 * one produces a measurable result, so the same commit can legitimately be mutated at a DIFFERENT file
 * in the two environments. Two `RECALL_CONFIRMED`s on different mutated files are not the same finding
 * reproduced - they are two different findings that happen to agree. This reports that case separately
 * (`REPRODUCED_OTHER_MUTATION`) rather than counting it as clean reproduction, because quietly merging
 * the two is exactly how a weaker claim ends up wearing a stronger claim's numbers.
 *
 * THE GATE. Any candidate that was `RECALL_CONFIRMED` on the host and `FALSE_GREEN` in the canonical
 * environment is a CRITICAL_REGRESSION, and this script exits non-zero when one exists. A safety
 * regression must not be something a reader has to notice in a table.
 *
 * Usage:
 *   npm run dogfood:compare -- --host <frozen bundle or run dir> --linux <run dir>
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface Row {
  repository: string;
  headSha: string;
  baseSha: string;
  classification: string;
  efficiency?: string;
  mutatedFile?: string;
  attemptedFiles?: string[];
  reason?: string;
}

/** The two classifications that mean the safety question was actually answered. */
const MEASURABLE: ReadonlySet<string> = new Set(["RECALL_CONFIRMED", "FALSE_GREEN"]);

export type Verdict =
  | "CRITICAL_REGRESSION"
  | "NEW_FALSE_GREEN"
  | "REPRODUCED"
  | "REPRODUCED_OTHER_MUTATION"
  | "COVERAGE_GAINED"
  | "PORTABILITY_LOSS"
  | "BOTH_UNMEASURABLE"
  | "MISSING_IN_CANONICAL"
  | "MISSING_ON_HOST";

/**
 * The taxonomy, in priority order. A false green outranks everything else it could also be described
 * as, because it is the only outcome that stops the programme.
 */
export function verdictFor(host: Row | undefined, linux: Row | undefined): Verdict {
  if (!host) return "MISSING_ON_HOST";
  if (!linux) return "MISSING_IN_CANONICAL";

  if (linux.classification === "FALSE_GREEN") {
    return host.classification === "RECALL_CONFIRMED" ? "CRITICAL_REGRESSION" : "NEW_FALSE_GREEN";
  }

  const hostMeasurable = MEASURABLE.has(host.classification);
  const linuxMeasurable = MEASURABLE.has(linux.classification);

  if (hostMeasurable && linuxMeasurable) {
    // Both confirmed. Same finding only if the same file was mutated; otherwise two different findings
    // that agree, which is a weaker statement and is labelled as one.
    return host.mutatedFile && linux.mutatedFile && host.mutatedFile === linux.mutatedFile
      ? "REPRODUCED"
      : "REPRODUCED_OTHER_MUTATION";
  }
  // Not a false green, but it says the safety evidence did not travel between environments.
  if (hostMeasurable && !linuxMeasurable) return "PORTABILITY_LOSS";
  // The environment answered a question the host could not - more coverage, not disagreement.
  if (!hostMeasurable && linuxMeasurable) return "COVERAGE_GAINED";
  return "BOTH_UNMEASURABLE";
}

/** Accepts either a frozen bundle directory or a raw run directory - both hold `results.jsonl`. */
function loadRows(dir: string): Row[] {
  const path = join(dir, "results.jsonl");
  if (!existsSync(path)) throw new Error(`no results.jsonl in ${dir}`);
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Row);
}

function funnel(rows: Row[]) {
  const count = (c: string): number => rows.filter((r) => r.classification === c).length;
  const confirmed = count("RECALL_CONFIRMED");
  const falseGreen = count("FALSE_GREEN");
  return {
    candidates: rows.length,
    environmentDirty: count("ENVIRONMENT_DIRTY"),
    invalidRun: count("INVALID_RUN"),
    recallUnmeasurable: count("RECALL_UNMEASURABLE"),
    measurable: confirmed + falseGreen,
    confirmed,
    falseGreen,
    efficient: rows.filter((r) => r.efficiency === "EFFICIENT").length,
    comparable: rows.filter((r) => r.efficiency === "COMPARABLE").length,
    overbroad: rows.filter((r) => r.efficiency === "SELECTION_OVERBROAD").length,
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i !== -1 ? args[i + 1] : undefined;
  };

  const hostDir = resolve(flag("host") ?? "");
  const linuxDir = resolve(flag("linux") ?? "");
  if (!existsSync(hostDir)) throw new Error("--host <frozen bundle or run directory> is required");
  if (!existsSync(linuxDir)) throw new Error("--linux <run directory> is required");

  const hostRows = loadRows(hostDir);
  const linuxRows = loadRows(linuxDir);

  const byHead = (rows: Row[]): Map<string, Row> => new Map(rows.map((r) => [r.headSha, r]));
  const hostByHead = byHead(hostRows);
  const linuxByHead = byHead(linuxRows);

  const allHeads = [...new Set([...hostByHead.keys(), ...linuxByHead.keys()])].sort();

  const rows = allHeads.map((head) => {
    const host = hostByHead.get(head);
    const linux = linuxByHead.get(head);
    return { head, host, linux, verdict: verdictFor(host, linux) };
  });

  const hostFunnel = funnel(hostRows);
  const linuxFunnel = funnel(linuxRows);

  console.log("\n  FUNNEL                        host      canonical");
  const line = (label: string, a: number, b: number): void =>
    console.log(`    ${label.padEnd(26)} ${String(a).padStart(4)}      ${String(b).padStart(4)}${a !== b ? "   <-- differs" : ""}`);
  line("candidates", hostFunnel.candidates, linuxFunnel.candidates);
  line("environment-dirty", hostFunnel.environmentDirty, linuxFunnel.environmentDirty);
  line("invalid runs", hostFunnel.invalidRun, linuxFunnel.invalidRun);
  line("recall-unmeasurable", hostFunnel.recallUnmeasurable, linuxFunnel.recallUnmeasurable);
  line("recall-MEASURABLE", hostFunnel.measurable, linuxFunnel.measurable);
  line("  recall confirmed", hostFunnel.confirmed, linuxFunnel.confirmed);
  line("  FALSE GREEN", hostFunnel.falseGreen, linuxFunnel.falseGreen);
  line("efficient", hostFunnel.efficient, linuxFunnel.efficient);
  line("comparable", hostFunnel.comparable, linuxFunnel.comparable);
  line("selection overbroad", hostFunnel.overbroad, linuxFunnel.overbroad);

  console.log("\n  PER-CANDIDATE\n");
  console.log(`    ${"commit".padEnd(11)} ${"host".padEnd(20)} ${"canonical".padEnd(20)} verdict`);
  for (const r of rows) {
    const h = r.host?.classification ?? "-";
    const l = r.linux?.classification ?? "-";
    const mutationNote =
      r.verdict === "REPRODUCED_OTHER_MUTATION" ? `  (host ${r.host?.mutatedFile ?? "?"} vs ${r.linux?.mutatedFile ?? "?"})` : "";
    console.log(`    ${r.head.slice(0, 9).padEnd(11)} ${h.padEnd(20)} ${l.padEnd(20)} ${r.verdict}${mutationNote}`);
  }

  const tally: Record<string, number> = {};
  for (const r of rows) tally[r.verdict] = (tally[r.verdict] ?? 0) + 1;

  console.log("\n  VERDICTS");
  for (const [verdict, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${verdict.padEnd(28)} ${n}`);
  }

  const critical = rows.filter((r) => r.verdict === "CRITICAL_REGRESSION" || r.verdict === "NEW_FALSE_GREEN");
  const portabilityLoss = tally.PORTABILITY_LOSS ?? 0;

  if (critical.length > 0) {
    console.log(`\n  STOP. ${critical.length} false green(s) in the canonical environment that the host did not report.`);
    console.log("  This is the outcome that halts corpus scaling. Investigate before anything else.\n");
    process.exitCode = 1;
    return;
  }

  const reproduced = (tally.REPRODUCED ?? 0) + (tally.REPRODUCED_OTHER_MUTATION ?? 0);
  console.log(
    `\n  No false greens in either environment. ${reproduced} of ${hostFunnel.measurable} host-measurable candidate(s) remained measurable and confirmed.`,
  );
  if (portabilityLoss > 0) {
    console.log(`  ${portabilityLoss} candidate(s) lost measurability - not a false green, but the evidence did not fully travel.`);
  }
  if ((tally.REPRODUCED_OTHER_MUTATION ?? 0) > 0) {
    console.log(`  ${tally.REPRODUCED_OTHER_MUTATION} confirmed via a DIFFERENT mutated file - agreement, not the same finding reproduced.`);
  }
  console.log();
}

// Importable for tests; only runs the report when invoked directly.
if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) main();
