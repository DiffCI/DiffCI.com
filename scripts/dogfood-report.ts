/**
 * Summarises a dogfood corpus produced by scripts/dogfood-observe.ts.
 *
 * The headline number people reach for - "DiffCI selected fewer tests on N% of commits" - is the least
 * interesting thing in the file, so it is reported last and without emphasis. For a product that can
 * cause a false green, the questions that matter first are: did anything violate non-interference or
 * the privacy boundary, how often did DiffCI refuse rather than guess, and how many SELECTIVE
 * decisions are even falsifiable from the evidence collected.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(dirname(import.meta.filename), "..");

interface Row {
  identity: { repository: string; stresses: string; baseSha: string; headSha: string; agentVersion: string };
  understanding: { testUniverse: number | "unknown"; graphNodes: number | "unknown"; graphConfidence: string; changedFiles: number | "unknown" };
  decision: { status: string; mode: string; reason: string; selected: number | "unknown"; total: number | "unknown" };
  counterfactual: { baselineMode: string; baselineSelected: number | "unknown"; netVersusBaseline: number | "unknown" };
  integrity: { worktreeUnchanged: boolean | "unknown"; reportOutsideRepository: boolean | "unknown"; includesFileContents: boolean | "unknown"; includesEnvironment: boolean | "unknown"; includesCredentials: boolean | "unknown" };
  economics: { analysisMs: number | "unknown" };
  notes: string[];
}

const path = resolve(process.argv[2] ?? join(repoRoot, ".dogfood", "corpus.jsonl"));
const rows = readFileSync(path, "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as Row);

if (rows.length === 0) {
  console.log("empty corpus");
  process.exit(0);
}

const n = (value: number | "unknown"): number | undefined => (typeof value === "number" ? value : undefined);

console.log(`\nDogfood corpus — ${rows.length} observation(s), agent ${rows[0]!.identity.agentVersion}`);
console.log(`  ${path}\n`);

// 1. SAFETY FIRST. A single violation here outweighs every efficiency number below it.
const violations = rows.filter((r) => r.notes.some((note) => note.includes("VIOLATED")));
const worktreeTouched = rows.filter((r) => r.integrity.worktreeUnchanged === false);
const leaky = rows.filter((r) => r.integrity.includesFileContents === true || r.integrity.includesCredentials === true || r.integrity.includesEnvironment === true);
const inTree = rows.filter((r) => r.integrity.reportOutsideRepository === false);

console.log("SAFETY");
console.log(`  non-interference violations       ${worktreeTouched.length}`);
console.log(`  privacy-boundary violations       ${leaky.length}`);
console.log(`  reports written inside the repo   ${inTree.length}`);
console.log(`  observations with any violation   ${violations.length}`);
for (const row of violations.slice(0, 10)) console.log(`    ${row.identity.headSha.slice(0, 9)}  ${row.notes.filter((x) => x.includes("VIOLATED")).join("; ")}`);

// 2. WHAT DID IT REFUSE TO DECIDE. Fail-closed is the product working, not the product failing.
const byMode = new Map<string, number>();
for (const row of rows) byMode.set(row.decision.mode, (byMode.get(row.decision.mode) ?? 0) + 1);
const errored = rows.filter((r) => r.decision.status !== "OBSERVED");

console.log("\nDECISIONS");
for (const [mode, count] of [...byMode].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${mode.padEnd(12)} ${String(count).padStart(4)}  ${((count / rows.length) * 100).toFixed(0)}%`);
}
console.log(`  non-OBSERVED status ${String(errored.length).padStart(4)}`);
const fallbackReasons = new Map<string, number>();
for (const row of rows.filter((r) => r.decision.mode === "FULL")) {
  fallbackReasons.set(row.decision.reason, (fallbackReasons.get(row.decision.reason) ?? 0) + 1);
}
if (fallbackReasons.size > 0) {
  console.log("  why it fell back to FULL:");
  for (const [reason, count] of [...fallbackReasons].sort((a, b) => b[1] - a[1])) console.log(`    ${String(count).padStart(3)}x  ${reason.slice(0, 96)}`);
}

// 3. FALSIFIABILITY. The number that decides whether this corpus can support a safety claim at all.
const selective = rows.filter((r) => r.decision.mode === "SELECTIVE");
const selectiveWithSelection = selective.filter((r) => (n(r.decision.selected) ?? 0) > 0);
console.log("\nFALSIFIABILITY");
console.log(`  SELECTIVE decisions                       ${selective.length}`);
console.log(`  ...of which selected at least one test    ${selectiveWithSelection.length}`);
console.log(`  ...falsified by observed execution        0  (this corpus records no execution)`);
console.log("  A SELECTIVE decision is falsified when a test OUTSIDE the selection changes outcome");
console.log("  between base and head. On green-to-green history no outcome changes, so green history");
console.log("  cannot falsify anything. Real failures or deliberate mutation are required.");

// 4. THE COMPARATOR. Reported as a distribution, never as one flattering average.
const compared = rows.map((r) => n(r.counterfactual.netVersusBaseline)).filter((x): x is number => x !== undefined);
const better = compared.filter((x) => x > 0).length;
const same = compared.filter((x) => x === 0).length;
const worse = compared.filter((x) => x < 0).length;

console.log("\nVERSUS A SIMPLE PATH-RULE CI");
console.log(`  DiffCI selected fewer   ${String(better).padStart(4)}`);
console.log(`  identical               ${String(same).padStart(4)}`);
console.log(`  DiffCI selected MORE    ${String(worse).padStart(4)}${worse > 0 ? "   <- these are the ones worth reading" : ""}`);
for (const row of rows.filter((r) => (n(r.counterfactual.netVersusBaseline) ?? 0) < 0).slice(0, 10)) {
  console.log(`    ${row.identity.headSha.slice(0, 9)}  DiffCI ${row.decision.selected} vs baseline ${row.counterfactual.baselineSelected}`);
}

// 5. COST. What the customer pays on every run, whatever the verdict.
const durations = rows.map((r) => n(r.economics.analysisMs)).filter((x): x is number => x !== undefined).sort((a, b) => a - b);
if (durations.length > 0) {
  const at = (q: number): number => durations[Math.min(durations.length - 1, Math.floor(durations.length * q))]!;
  console.log("\nANALYSIS OVERHEAD (per commit, added to every CI run)");
  console.log(`  median ${at(0.5)}ms   p90 ${at(0.9)}ms   max ${durations[durations.length - 1]}ms`);
}

// 6. Anything the harness could not classify. Unknowns are printed, never silently treated as zero.
const unknowns = rows.filter((r) => r.decision.selected === "unknown" || r.understanding.graphNodes === "unknown");
if (unknowns.length > 0) console.log(`\nUNCLASSIFIED  ${unknowns.length} observation(s) missing decision or graph data`);

const otherNotes = rows.flatMap((r) => r.notes.filter((note) => !note.includes("VIOLATED")).map((note) => ({ sha: r.identity.headSha, note })));
if (otherNotes.length > 0) {
  console.log(`\nNOTES  ${otherNotes.length}`);
  const grouped = new Map<string, number>();
  for (const { note } of otherNotes) grouped.set(note.slice(0, 90), (grouped.get(note.slice(0, 90)) ?? 0) + 1);
  for (const [note, count] of [...grouped].sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(3)}x  ${note}`);
}
console.log();
