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

export interface ParsedTestOutput {
  /** Undefined means the output could not be understood - never assume zero. */
  failures: number | undefined;
  /** Best-effort names of failing tests. Used as evidence, never to derive the count. */
  failedNames: string[];
  /** Which adapter matched, for the record. */
  framework: string | undefined;
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
  for (const adapter of ADAPTERS) {
    const failures = adapter.failures(output);
    if (failures === undefined) continue;
    return { failures, failedNames: adapter.names(output), framework: adapter.name };
  }
  return { failures: undefined, failedNames: [], framework: undefined };
}

/** The runners this module can classify. Useful for reporting coverage of a corpus. */
export const SUPPORTED_RUNNERS = ADAPTERS.map((adapter) => adapter.name);
