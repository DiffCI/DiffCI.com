/**
 * Reading a failure count out of a test runner's output, for the mutation-recall pass.
 *
 * WHY THIS IS ITS OWN MODULE. The mutation classification turns entirely on one question - did this
 * run detect the mutation - and the only evidence available is whatever the runner printed. Getting
 * that wrong in the safe direction (reporting failures that did not happen) wastes a run; getting it
 * wrong in the unsafe direction (reporting zero when tests failed) would manufacture a RECALL_CONFIRMED
 * out of a run that proved nothing. So every parser here returns `undefined` rather than `0` when it
 * cannot find a summary line, and the caller treats `undefined` as INVALID_RUN.
 *
 * "No failures found" and "could not tell" must never collapse into the same answer.
 *
 * Each adapter matches the runner's own summary line rather than counting individual markers, because
 * summary lines are stable across versions and marker glyphs are not.
 */

import { parseGoTestOutput } from "../src/repo/adapters/go-test.js";

export interface ParsedTestOutput {
  /** Undefined means the output could not be understood - never assume zero. */
  failures: number | undefined;
  /** Best-effort names of failing tests. Used as evidence, never to derive the count. */
  failedNames: string[];
  /** Which adapter matched, for the record. */
  framework: string | undefined;
}

/**
 * Removes ANSI escape sequences before any adapter sees the output.
 *
 * WHY THIS IS NOT COSMETIC. Every adapter here anchors its summary line with `^\s*`. A coloured runner
 * emits that line starting with an escape sequence rather than whitespace, so the anchor fails, the
 * parser correctly reports "cannot understand this output", and a perfectly good run is recorded as
 * INVALID_RUN.
 *
 * Found on 2026-08-29: honojs/hono in the canonical Linux environment returned INVALID_RUN for all 22
 * mutation candidates. Every suite had actually PASSED - exit 0, 147 files, 4961 tests - and the summary
 * line was present and correct, wrapped in colour codes. The same repository parsed fine on the Windows
 * host, which emitted the identical summary uncoloured. So it presented as an environment disagreement
 * and was really a parser that could not read its own runner in colour. `FORCE_COLOR=0` is already set
 * by the harness and did not prevent it, because `CI=1` is set alongside and vitest colourises under CI.
 *
 * SAFE WITH RESPECT TO EXISTING EVIDENCE: stripping is a no-op on output containing no escape
 * sequences, so any result previously parsed from uncoloured output is unchanged, and the frozen
 * developer-host bundles stay valid rather than needing to be re-derived.
 *
 * Handles CSI sequences (colour, cursor movement) and OSC sequences (hyperlinks, window title,
 * terminated by BEL or ST), which is the full set a test runner realistically emits.
 */
export function stripAnsi(output: string): string {
  const OSC = /\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g;
  const CSI = /\x1B\[[0-9;?]*[ -/]*[@-~]/g;
  return output.replace(OSC, "").replace(CSI, "");
}

interface Adapter {
  name: string;
  /** Returns a failure count if this adapter recognises the output, otherwise undefined. */
  failures(output: string): number | undefined;
  names(output: string): string[];
}

const ADAPTERS: Adapter[] = [
  {
    // `node --test` / tsx --test. TAP-ish summary: "# fail 2", or the spec reporter's "ℹ fail 2".
    name: "node:test",
    failures(output) {
      const match = /^[#ℹ] fail (\d+)\s*$/m.exec(output);
      return match ? Number(match[1]) : undefined;
    },
    names(output) {
      return [...output.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]!.trim());
    },
  },
  {
    // Vitest: "Tests  1 failed | 4 passed (5)" or "Tests  5 passed (5)". The failed clause is absent
    // entirely when nothing failed, which is why a missing clause means zero rather than unknown -
    // but only once the "Tests" line itself has been found.
    name: "vitest",
    failures(output) {
      const line = /^\s*Tests\s+(.+)$/m.exec(output);
      if (!line) return undefined;
      const failed = /(\d+) failed/.exec(line[1]!);
      return failed ? Number(failed[1]) : 0;
    },
    names(output) {
      return [...output.matchAll(/^\s*(?:×|FAIL)\s+(.+?)(?:\s+\d+ms)?$/gm)].map((m) => m[1]!.trim()).slice(0, 50);
    },
  },
  {
    // Jest: "Tests:       1 failed, 5 passed, 6 total".
    name: "jest",
    failures(output) {
      const line = /^Tests:\s+(.+)$/m.exec(output);
      if (!line) return undefined;
      const failed = /(\d+) failed/.exec(line[1]!);
      return failed ? Number(failed[1]) : 0;
    },
    names(output) {
      return [...output.matchAll(/^\s*●\s+(.+)$/gm)].map((m) => m[1]!.trim()).slice(0, 50);
    },
  },
  {
    // Mocha: "5 passing" and, only when something failed, "2 failing".
    name: "mocha",
    failures(output) {
      if (!/^\s*\d+ passing/m.test(output) && !/^\s*\d+ failing/m.test(output)) return undefined;
      const failing = /^\s*(\d+) failing/m.exec(output);
      return failing ? Number(failing[1]) : 0;
    },
    names(output) {
      return [...output.matchAll(/^\s*\d+\)\s+(.+)$/gm)].map((m) => m[1]!.trim()).slice(0, 50);
    },
  },
];

/**
 * Tries every adapter and returns the first that recognises the output.
 *
 * Order matters only for ambiguity, and there is one real case: a vitest run can print a line
 * containing "Tests" while also emitting TAP if configured that way. node:test is tried first because
 * its summary line is the most specific - `# fail N` appears in no other runner's output.
 */
export function parseTestOutput(output: string): ParsedTestOutput {
  const plain = stripAnsi(output);
  const go = parseGoTestOutput(plain);
  if (go) return { ...go, framework: "go:test" };
  // Do not reinterpret an incomplete Go JSON stream as another runner's textual output.
  if (/^\s*\{.*"Action"\s*:/m.test(plain)) return { failures: undefined, failedNames: [], framework: "go:test" };
  for (const adapter of ADAPTERS) {
    const failures = adapter.failures(plain);
    if (failures === undefined) continue;
    return { failures, failedNames: adapter.names(plain), framework: adapter.name };
  }
  return { failures: undefined, failedNames: [], framework: undefined };
}

/**
 * How many test FILES the runner executed, or undefined if it cannot be read.
 *
 * The economic eligibility gate divides a full-suite CPU measurement by this to model a cost per test
 * file. Supplying it by hand works for repositories someone has already studied; it cannot work for a
 * prospect's repository, which is the only place the gate is commercially useful.
 *
 * Undefined, never a guess, for the same reason every other parser here refuses to invent a number: a
 * wrong denominator silently rescales the whole prediction, and a fabricated one would do so invisibly.
 * The caller must refuse to produce a verdict rather than proceed on an assumed file count.
 *
 * Vitest reports the total in parentheses after the passed/skipped breakdown - `Test Files  182 passed
 * | 1 skipped (183)` - so the parenthesised figure is the one to take, not the passed count. Jest
 * reports `Test Suites: 3 passed, 3 total`.
 */
export function parseTestFileCount(output: string): number | undefined {
  const plain = stripAnsi(output);

  const vitest = /^\s*Test Files\s+(.+)$/m.exec(plain);
  if (vitest) {
    const total = /\((\d+)\)\s*$/.exec(vitest[1]!.trim());
    if (total) return Number(total[1]);
    // No parenthesised total: a single-category line such as "Test Files  4 passed" still states a count.
    const single = /^(\d+)\s+\w+$/.exec(vitest[1]!.trim());
    if (single) return Number(single[1]);
    return undefined;
  }

  const jest = /^Test Suites:\s+(.+)$/m.exec(plain);
  if (jest) {
    const total = /(\d+)\s+total/.exec(jest[1]!);
    if (total) return Number(total[1]);
  }

  return undefined;
}

/** The runners this module can classify. Useful for reporting coverage of a corpus. */
export const SUPPORTED_RUNNERS = [...ADAPTERS.map((adapter) => adapter.name), "go:test"];
