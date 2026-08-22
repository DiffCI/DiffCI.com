/**
 * Generalized environment/runtime parity detection (Preflight P1, Part B). Deliberately NOT
 * node:sqlite-hardcoded: the real 2026-08-22 incident (package.json's engines.node was unset/wrong
 * while the self-hosted runner's Dockerfile pinned Node 20, so `node:sqlite` - stable only from
 * 22.5.0 - failed with ERR_UNKNOWN_BUILTIN_MODULE for six consecutive pushes; see the dedicated case
 * study this incident gets under docs/research/ per Preflight P1 Part K) is one INSTANCE of a general
 * shape: a declared runtime requirement and a provisioned runtime silently drifting apart. This module
 * detects that shape for any runtime kind (only "node" is populated with real sources today - the
 * types below are intentionally not Node-specific).
 *
 * Pure and I/O-free by design, same discipline as fingerprint.ts/preventability.ts: callers (a real
 * check runner, or a test) supply file contents already read; nothing here touches the filesystem or
 * a live process, so results are 100% reproducible from a fixed input and safe to unit test with
 * synthetic fixtures.
 */

export type RuntimeKind = "node" | "npm" | string;

/**
 * "requirement" = a declaration of what the CODE needs to run correctly (package.json engines.*) -
 * the ground truth a parity check exists to protect. "provisioning" = a declaration of what an
 * execution environment actually SUPPLIES (a Dockerfile's runtime install line, a CI workflow's
 * setup-* action/version pin) - what will actually be present when the code runs. The real incident
 * was a provisioning source (Dockerfile: Node 20) silently falling behind an unstated requirement
 * (the code needed >=22.5.0, but nothing declared that until the fix).
 */
export type RuntimeSourceKind = "requirement" | "provisioning";

export interface RuntimeRequirementSource {
  /** Where this was found, e.g. "package.json#engines.node", ".nvmrc", "ops/github-runner/Dockerfile#L54", "workflow:ci.yml#setup-node". Free text, not parsed - purely for human-facing evidence, matching this project's fingerprinting discipline of preserving real provenance over normalized summaries. */
  sourceId: string;
  runtime: RuntimeKind;
  kind: RuntimeSourceKind;
  /** Exactly as found in the source file - never pre-normalized, so a MALFORMED verdict can show the reader the real unparseable string. */
  rawValue: string;
}

export interface ParsedRuntimeRequirement extends RuntimeRequirementSource {
  malformed: boolean;
  malformedReason?: string;
  /** Only set when !malformed. */
  minVersion?: SemVer;
  /** Only set when !malformed and the source is a closed range (e.g. ">=X <Y" or "~X.Y.Z"), not an open-ended minimum. */
  maxVersionExclusive?: SemVer;
  isExactPin: boolean;
}

export type RuntimeParityVerdict = "COMPATIBLE" | "NEWER_COMPATIBLE" | "INCOMPATIBLE" | "MAJOR_MISMATCH" | "MISSING" | "CONFLICTING" | "MALFORMED";

export interface RuntimeParityResult {
  runtime: RuntimeKind;
  /** The version actually present in the environment the check runs in (e.g. process.version on the
   * runner, or a probed value from the target execution environment) - undefined if not supplied,
   * which forces MISSING/insufficient-evidence handling rather than a guess. */
  actualVersion?: string;
  sources: ParsedRuntimeRequirement[];
  verdict: RuntimeParityVerdict;
  reasons: string[];
}

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

/** Minimal internal semver parser/comparator - deliberately not a dependency. Supports exactly the
 * forms real Node/npm ecosystem files actually use for a runtime pin: "X.Y.Z", ">=X.Y.Z",
 * "^X.Y.Z", "~X.Y.Z", "X.Y.x" / "X.x" wildcards, and ">=X.Y.Z <A.B.C" compound ranges. Anything
 * else is reported as malformed rather than guessed at - this project never fabricates results from
 * evidence it can't actually parse (same rule fingerprint.ts follows for error text). */
export function parseSemVer(raw: string): SemVer | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function compareSemVer(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function formatSemVer(v: SemVer): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

/**
 * Parses one raw runtime-version declaration into a minVersion (and, for closed ranges, a
 * maxVersionExclusive). Returns malformed:true with a human-readable reason for anything not in the
 * supported forms above, rather than silently misinterpreting it.
 */
export function parseRuntimeSource(source: RuntimeRequirementSource): ParsedRuntimeRequirement {
  const raw = source.rawValue.trim();

  // Compound range: ">=X.Y.Z <A.B.C"
  const compound = /^>=\s*(\d+\.\d+\.\d+)\s+<\s*(\d+\.\d+\.\d+)$/.exec(raw);
  if (compound) {
    const min = parseSemVer(compound[1]!);
    const max = parseSemVer(compound[2]!);
    if (!min || !max) return { ...source, malformed: true, malformedReason: `compound range "${raw}" has an unparseable bound`, isExactPin: false };
    return { ...source, malformed: false, minVersion: min, maxVersionExclusive: max, isExactPin: false };
  }

  // ">=X.Y.Z"
  const gte = /^>=\s*(\d+\.\d+\.\d+)$/.exec(raw);
  if (gte) {
    const min = parseSemVer(gte[1]!);
    if (!min) return { ...source, malformed: true, malformedReason: `">=" bound "${raw}" is not valid semver`, isExactPin: false };
    return { ...source, malformed: false, minVersion: min, isExactPin: false };
  }

  // "^X.Y.Z" - compatible-with, i.e. [X.Y.Z, (X+1).0.0)
  const caret = /^\^\s*(\d+)\.(\d+)\.(\d+)$/.exec(raw);
  if (caret) {
    const min = { major: Number(caret[1]), minor: Number(caret[2]), patch: Number(caret[3]) };
    return { ...source, malformed: false, minVersion: min, maxVersionExclusive: { major: min.major + 1, minor: 0, patch: 0 }, isExactPin: false };
  }

  // "~X.Y.Z" - approximately, i.e. [X.Y.Z, X.(Y+1).0)
  const tilde = /^~\s*(\d+)\.(\d+)\.(\d+)$/.exec(raw);
  if (tilde) {
    const min = { major: Number(tilde[1]), minor: Number(tilde[2]), patch: Number(tilde[3]) };
    return { ...source, malformed: false, minVersion: min, maxVersionExclusive: { major: min.major, minor: min.minor + 1, patch: 0 }, isExactPin: false };
  }

  // "X.Y.x" / "X.x" wildcard - i.e. all patch/minor releases within that prefix
  const wildcard = /^(\d+)(?:\.(\d+))?\.x$/.exec(raw);
  if (wildcard) {
    const major = Number(wildcard[1]);
    if (wildcard[2] !== undefined) {
      const minor = Number(wildcard[2]);
      return { ...source, malformed: false, minVersion: { major, minor, patch: 0 }, maxVersionExclusive: { major, minor: minor + 1, patch: 0 }, isExactPin: false };
    }
    return { ...source, malformed: false, minVersion: { major, minor: 0, patch: 0 }, maxVersionExclusive: { major: major + 1, minor: 0, patch: 0 }, isExactPin: false };
  }

  // Exact pin: "X.Y.Z"
  const exact = parseSemVer(raw);
  if (exact) {
    return { ...source, malformed: false, minVersion: exact, maxVersionExclusive: { major: exact.major, minor: exact.minor, patch: exact.patch + 1 }, isExactPin: true };
  }

  return { ...source, malformed: true, malformedReason: `"${raw}" does not match any supported form (exact X.Y.Z, >=X.Y.Z, ^X.Y.Z, ~X.Y.Z, X.Y.x, or ">=X.Y.Z <A.B.C")`, isExactPin: false };
}

function satisfies(version: SemVer, req: ParsedRuntimeRequirement): boolean {
  if (req.malformed || !req.minVersion) return false;
  if (compareSemVer(version, req.minVersion) < 0) return false;
  if (req.maxVersionExclusive && compareSemVer(version, req.maxVersionExclusive) >= 0) return false;
  return true;
}

/**
 * Two requirement ranges "conflict" when their satisfying version sets have no overlap at all - e.g.
 * an exact pin at Node 20 alongside a ">=22.5.0" minimum. A minimum-only requirement (">=22.5.0")
 * never conflicts with a wider minimum-only requirement (">=20.0.0") - the narrower one simply
 * subsumes it. Deliberately conservative: only reports CONFLICTING when ranges are PROVABLY disjoint,
 * never when they merely differ in exact wording (matches this project's "never invent findings from
 * ambiguous evidence" discipline).
 */
function rangesConflict(a: ParsedRuntimeRequirement, b: ParsedRuntimeRequirement): boolean {
  if (a.malformed || b.malformed || !a.minVersion || !b.minVersion) return false;
  const aMax = a.maxVersionExclusive;
  const bMax = b.maxVersionExclusive;
  // a's range starts after b's range ends
  if (bMax && compareSemVer(a.minVersion, bMax) >= 0) return true;
  // b's range starts after a's range ends
  if (aMax && compareSemVer(b.minVersion, aMax) >= 0) return true;
  return false;
}

/**
 * Evaluates parity for one runtime kind across every declared source found for it, against the
 * actual version present in the environment being checked. `actualVersion` is intentionally the
 * caller's responsibility to supply from a REAL probe (process.version, or a queried target
 * environment - see the environment-parity probe used to validate the rewritten github-runner-worker.ts,
 * which returned "v22.23.2" from a live Cloudflare Sandbox exec) - this function never assumes or
 * defaults a runtime version.
 */
export function evaluateRuntimeParity(runtime: RuntimeKind, sources: RuntimeRequirementSource[], actualVersion?: string): RuntimeParityResult {
  const parsed = sources.filter((s) => s.runtime === runtime).map(parseRuntimeSource);
  const reasons: string[] = [];

  if (parsed.length === 0) {
    return { runtime, actualVersion, sources: parsed, verdict: "MISSING", reasons: [`no declared ${runtime} runtime requirement found in any known source (package.json engines, .nvmrc, Dockerfile, CI workflow setup step)`] };
  }

  const malformed = parsed.filter((p) => p.malformed);
  const wellFormed = parsed.filter((p) => !p.malformed);
  if (malformed.length > 0) {
    for (const m of malformed) reasons.push(`${m.sourceId}: ${m.malformedReason}`);
    if (wellFormed.length === 0) {
      return { runtime, actualVersion, sources: parsed, verdict: "MALFORMED", reasons };
    }
    // At least one well-formed source survives - keep evaluating on those, but the malformed ones
    // stay in `reasons` as a real, disclosed gap rather than being silently dropped.
  }

  for (let i = 0; i < wellFormed.length; i++) {
    for (let j = i + 1; j < wellFormed.length; j++) {
      if (rangesConflict(wellFormed[i]!, wellFormed[j]!)) {
        reasons.push(`${wellFormed[i]!.sourceId} ("${wellFormed[i]!.rawValue}") and ${wellFormed[j]!.sourceId} ("${wellFormed[j]!.rawValue}") declare non-overlapping ${runtime} version ranges`);
      }
    }
  }
  if (reasons.some((r) => r.includes("non-overlapping"))) {
    return { runtime, actualVersion, sources: parsed, verdict: "CONFLICTING", reasons };
  }

  if (!actualVersion) {
    reasons.push(`no actual ${runtime} version supplied to compare against declared requirements - parity cannot be evaluated, only declaration consistency`);
    return { runtime, actualVersion, sources: parsed, verdict: "MISSING", reasons };
  }
  const actual = parseSemVer(actualVersion.replace(/^v/, ""));
  if (!actual) {
    reasons.push(`actual version "${actualVersion}" is not a parseable exact semver`);
    return { runtime, actualVersion, sources: parsed, verdict: "MALFORMED", reasons };
  }

  // The strictest requirement source (highest minVersion) is the binding one - satisfying every
  // declared source implies satisfying their tightest common bound. Since non-overlapping pairs were
  // already ruled out above, taking the max minVersion here is sound.
  const strictest = wellFormed.reduce((a, b) => (compareSemVer(a.minVersion!, b.minVersion!) >= 0 ? a : b));
  const unsatisfied = wellFormed.filter((r) => !satisfies(actual, r));

  if (unsatisfied.length === 0) {
    if (actual.major > strictest.minVersion!.major) {
      reasons.push(`actual ${runtime} ${actualVersion} satisfies every declared requirement (strictest: ${strictest.sourceId} "${strictest.rawValue}") but is a newer major version than declared - compatible today, worth confirming intentional`);
      return { runtime, actualVersion, sources: parsed, verdict: "NEWER_COMPATIBLE", reasons };
    }
    reasons.push(`actual ${runtime} ${actualVersion} satisfies every declared requirement (strictest: ${strictest.sourceId} "${strictest.rawValue}")`);
    return { runtime, actualVersion, sources: parsed, verdict: "COMPATIBLE", reasons };
  }

  const majorMismatch = unsatisfied.some((r) => actual.major !== r.minVersion!.major);
  for (const u of unsatisfied) {
    reasons.push(`actual ${runtime} ${actualVersion} does not satisfy ${u.sourceId} ("${u.rawValue}")`);
  }
  if (majorMismatch) {
    return { runtime, actualVersion, sources: parsed, verdict: "MAJOR_MISMATCH", reasons };
  }
  return { runtime, actualVersion, sources: parsed, verdict: "INCOMPATIBLE", reasons };
}

// --- Real, repo-specific source extraction -------------------------------------------------------
// Kept separate from the pure evaluation logic above so tests can exercise evaluateRuntimeParity()
// against fully synthetic sources without needing real file contents. These extractors are still
// pure functions (they take file text, not paths), so callers control I/O and testability holds
// throughout - only the regexes below are DiffCI-repo-shaped.

/** Extracts a "node" requirement source from a parsed package.json's `engines.node` field, if present. */
export function extractPackageJsonEngineSource(packageJsonText: string, sourceId = "package.json#engines.node"): RuntimeRequirementSource | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJsonText);
  } catch {
    return undefined; // caller sees this as "no source found" here, not this module's job to report malformed JSON
  }
  const engines = (parsed as { engines?: Record<string, string> })?.engines;
  const node = engines?.node;
  if (typeof node !== "string" || node.trim() === "") return undefined;
  return { sourceId, runtime: "node", kind: "requirement", rawValue: node };
}

/** Extracts a "node" provisioning source from an `.nvmrc` file's contents, if present. */
export function extractNvmrcSource(nvmrcText: string, sourceId = ".nvmrc"): RuntimeRequirementSource | undefined {
  const trimmed = nvmrcText.trim();
  if (!trimmed) return undefined;
  return { sourceId, runtime: "node", kind: "provisioning", rawValue: trimmed.replace(/^v/, "") };
}

/** Extracts a "node" provisioning source from a Dockerfile's NodeSource setup line
 * (`setup_<major>.x`), the pattern ops/github-runner/Dockerfile uses. Returns undefined if no such
 * line is found - a Dockerfile using a different install method (e.g. `FROM node:22-slim`) is not
 * yet recognized here and is intentionally left unreported rather than guessed at; extend the regex
 * below if that pattern is adopted. */
export function extractDockerfileNodeSetupSource(dockerfileText: string, sourceId: string): RuntimeRequirementSource | undefined {
  const setupMatch = /setup_(\d+)\.x/.exec(dockerfileText);
  if (setupMatch) return { sourceId, runtime: "node", kind: "provisioning", rawValue: `${setupMatch[1]}.x` };
  const fromMatch = /FROM\s+node:(\d+)(?:\.(\d+)(?:\.(\d+))?)?/i.exec(dockerfileText);
  if (fromMatch) {
    const raw = fromMatch[3] ? `${fromMatch[1]}.${fromMatch[2]}.${fromMatch[3]}` : fromMatch[2] ? `${fromMatch[1]}.${fromMatch[2]}.x` : `${fromMatch[1]}.x`;
    return { sourceId, runtime: "node", kind: "provisioning", rawValue: raw };
  }
  return undefined;
}
