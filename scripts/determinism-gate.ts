/**
 * SOURCE_PINNED ≠ EXECUTION_ENVIRONMENT_PINNED.
 *
 * A commit SHA pins source. It does not pin the dependency graph. `CI_REPRODUCTION_SAMPLE_01` member 5
 * proved the difference empirically: `babel/babel-loader` at `778e7c54d` (2026-08-04) runs
 * `yarn add -D webpack@5`, a floating range resolved against the live registry at install time. Today
 * that resolves to webpack 5.110.3, published 2026-09-01 — **28 days after the commit whose CI passed** —
 * and two tests that assert on webpack's build-log content now fail.
 *
 * Nothing was wrong with the repository, the container, or the engine. The pipeline's own past is not
 * reproducible, by us or by its maintainers.
 *
 * So a reproduction attempt must be able to say so BEFORE it scores anything. This is a gate on the
 * EXPERIMENT. Making dependency reproducibility an input to DiffCI's own confidence and refusal is a
 * separate, later change to inference, deliberately not made here — the same-five regression must
 * attribute transitions to the semantic repair, not to a simultaneous engine change.
 */

/** Installs that resolve strictly from a committed lockfile. */
const PINNED_INSTALL: RegExp[] = [
  /^npm\s+ci\b/,
  /^yarn\s+(install\s+)?--immutable\b/,
  /^yarn\s+(install\s+)?--frozen-lockfile\b/,
  /^pnpm\s+(install|i)\s+--frozen-lockfile\b/,
  /^bun\s+install\s+--frozen-lockfile\b/,
];

/**
 * Installs that resolve against the registry at run time.
 *
 * `yarn add`, `yarn up`/`upgrade` and `npm i <spec>` all MUTATE the dependency graph from whatever the
 * registry holds when they run. A bare `yarn` or `npm install` also resolves live, but only for entries
 * a lockfile does not already fix — so it is reported separately rather than lumped in.
 */
const FLOATING_INSTALL: RegExp[] = [
  /^yarn\s+add\b/,
  /^yarn\s+(up|upgrade)\b/,
  /^npm\s+(i|install)\s+[^-\s]/,
  /^pnpm\s+add\b/,
  /^bun\s+add\b/,
];

/** A bare install, which honours a lockfile where one exists and resolves live where it does not. */
const LOCKFILE_DEPENDENT_INSTALL: RegExp[] = [/^yarn\s*$/, /^yarn\s+install\s*$/, /^npm\s+install\s*$/, /^pnpm\s+(install|i)\s*$/];

export type DeterminismVerdict =
  | "EXECUTION_ENVIRONMENT_PINNED"
  | "FLOATING_DEPENDENCIES"
  /** A run-time install, but every spec names an exact version. */
  | "EXACT_SPEC_MUTATION"
  | "LOCKFILE_DEPENDENT"
  | "NO_INSTALL_OBSERVED";

/**
 * Does a package spec name an exact version, or a range?
 *
 * This distinction stops two different situations being reported as one. babel-loader installs
 * `webpack@5` — a RANGE, which resolved to a version published 28 days after the commit. webpack
 * installs `pkg-pr-new@0.0.66` — an EXACT version, whose direct resolution is stable. Both mutate the
 * dependency graph at run time; only one of them can silently become a different package.
 *
 * A bare name with no `@version` is a range (whatever the registry calls latest).
 */
function specIsExact(spec: string): boolean {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return false;
  const version = spec.slice(at + 1);
  return /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(version);
}

/** The package specs a mutating install names, i.e. its non-flag arguments after the subcommand. */
function specsOf(line: string): string[] {
  const tokens = line.split(/\s+/).filter(Boolean);
  return tokens.slice(2).filter((t) => !t.startsWith("-"));
}

export interface DeterminismReport {
  verdict: DeterminismVerdict;
  /** Commands that resolve against the registry at run time, verbatim. */
  floating: string[];
  /** Commands that resolve strictly from a lockfile. */
  pinned: string[];
  /** Bare installs, which are pinned only to the extent a lockfile covers them. */
  lockfileDependent: string[];
  /**
   * Whether a historical reproduction claim is defensible.
   *
   * FALSE does not mean the run is worthless — it means any divergence cannot be attributed to the
   * engine, the container, or the repository at that commit, because the inputs are not the same inputs.
   */
  historicalReproductionAvailable: boolean;
  reason: string;
}

/**
 * Classifies a reference plan's install behaviour.
 *
 * Takes commands rather than a repository so it is exhaustively testable and cannot silently read
 * anything else.
 */
export function assessDeterminism(commands: string[][]): DeterminismReport {
  const lines = commands.map((c) => c.join(" ").trim());
  const floating = lines.filter((l) => FLOATING_INSTALL.some((p) => p.test(l)));
  const pinned = lines.filter((l) => PINNED_INSTALL.some((p) => p.test(l)));
  const lockfileDependent = lines.filter((l) => LOCKFILE_DEPENDENT_INSTALL.some((p) => p.test(l)));

  if (floating.length > 0) {
    // Only a RANGE can silently become a different package. An exact spec still mutates the graph, but
    // its direct resolution is stable, and reporting the two as one would overclaim.
    const ranged = floating.filter((l) => specsOf(l).some((s) => !specIsExact(s)));
    if (ranged.length === 0) {
      return {
        verdict: "EXACT_SPEC_MUTATION",
        floating,
        pinned,
        lockfileDependent,
        historicalReproductionAvailable: true,
        reason:
          `${floating.length} step(s) mutate the dependency graph at run time, but every spec names an exact ` +
          `version: ${floating.join("; ")}. Direct resolution is stable; transitive resolution is not guaranteed.`,
      };
    }
    return {
      verdict: "FLOATING_DEPENDENCIES",
      floating,
      pinned,
      lockfileDependent,
      historicalReproductionAvailable: false,
      reason:
        `${ranged.length} step(s) resolve a VERSION RANGE against the registry at run time: ${ranged.join("; ")}. ` +
        "The commit pins source, not the dependency graph, so this pipeline's own past is not reproducible - " +
        "by us or by its maintainers. Divergence here cannot be attributed to the engine, the container or the repository.",
    };
  }

  if (pinned.length > 0) {
    return {
      verdict: "EXECUTION_ENVIRONMENT_PINNED",
      floating,
      pinned,
      lockfileDependent,
      historicalReproductionAvailable: true,
      reason: `every install resolves from a committed lockfile: ${pinned.join("; ")}`,
    };
  }

  if (lockfileDependent.length > 0) {
    return {
      verdict: "LOCKFILE_DEPENDENT",
      floating,
      pinned,
      lockfileDependent,
      // Defensible ONLY if a lockfile exists, which this function cannot see. Reported honestly rather
      // than assumed either way - the caller knows whether a lockfile is committed.
      historicalReproductionAvailable: true,
      reason:
        `install is bare (${lockfileDependent.join("; ")}), so it is pinned exactly to the extent a committed ` +
        "lockfile covers it. Whether a lockfile exists is not visible from the commands alone.",
    };
  }

  return {
    verdict: "NO_INSTALL_OBSERVED",
    floating,
    pinned,
    lockfileDependent,
    historicalReproductionAvailable: true,
    reason: "no install step was observed in this plan, so nothing resolves at run time",
  };
}
