/**
 * The pinned-agent-artifact invariant (replaces the pinned-action-ref invariant, 2026-08-27).
 *
 * WHAT CHANGED AND WHY. The previous invariant said: no 40-character public GitHub Action SHA, no
 * onboarding. That was the right property expressed through the wrong noun. DiffCI is proprietary and
 * source-private, so it is not distributed as a third-party `uses:` Action at all - it is an
 * authenticated package the customer's workflow installs and runs. A rule phrased in terms of Action
 * SHAs would now be unsatisfiable by construction, and the honest response to that is to restate the
 * property, not to delete it.
 *
 * THE PROPERTY ITSELF IS UNCHANGED, and it is the whole point:
 *
 *     No customer credential or installation instruction may be generated unless it identifies an
 *     IMMUTABLE, INTEGRITY-VERIFIABLE DiffCI agent artifact.
 *
 * Immutable: the identifier resolves to exactly one artifact forever. `@latest`, `^1.4`, `~1.4` and
 * `1.x` are not identifiers, they are queries - they resolve to whatever is newest at install time,
 * which means the code executing in a customer's CI can change without their repository changing.
 * That is precisely the property this exists to deny.
 *
 * Integrity-verifiable: the customer's package manager can check that the bytes it received are the
 * bytes we named. An exact version alone is not enough - a version can in principle be republished,
 * and a registry can be compromised - so the subresource-integrity hash is carried too, and both are
 * required together.
 *
 * ARTIFACT-NEUTRAL ON PURPOSE. npm is today's delivery mechanism, not the architecture. The intended
 * end state is a short-lived, installation-authenticated download issued through the DiffCI GitHub
 * App, so customers never manage a long-lived registry token. That will be a different KIND of
 * artifact with a different identifier shape, and it must be expressible here without another rewrite
 * of every call site - hence the discriminated union rather than an npm-shaped record.
 */

declare const pinnedBrand: unique symbol;

/** How the customer's runner obtains the agent. */
export type ArtifactKind =
  /** A package installed from an authenticated npm registry. */
  | "npm"
  /** A container image addressed by digest. Not yet issued; the shape is fixed so it can be. */
  | "oci";

interface PinnedArtifactBase {
  readonly kind: ArtifactKind;
  /** Human-readable identity for logs and the console, e.g. "@diffci/observer@1.4.2". */
  readonly display: string;
  /** Brand only - never read. Not exported, so this type cannot be forged outside this module. */
  readonly [pinnedBrand]: true;
}

export interface PinnedNpmArtifact extends PinnedArtifactBase {
  readonly kind: "npm";
  /** Package name, including scope. */
  readonly name: string;
  /** An EXACT semver version. Never a range, never a dist-tag. */
  readonly version: string;
  /** Subresource integrity, as npm records it: `sha512-<base64>`. */
  readonly integrity: string;
}

export interface PinnedOciArtifact extends PinnedArtifactBase {
  readonly kind: "oci";
  readonly image: string;
  /** `sha256:<64 hex>` - a digest, never a tag. */
  readonly digest: string;
}

export type PinnedAgentArtifact = PinnedNpmArtifact | PinnedOciArtifact;

export type ArtifactRejection =
  | "missing"
  | "malformed"
  /** Shaped correctly, but names something that can be repointed - a range, a tag, a dist-tag. */
  | "not_immutable"
  /** Immutable, but with no integrity value the client could verify the bytes against. */
  | "not_verifiable";

export interface ParsedArtifact {
  ok: true;
  artifact: PinnedAgentArtifact;
}

export interface RejectedArtifact {
  ok: false;
  rejection: ArtifactRejection;
  /** Safe to log or show an operator: a configuration value, never a credential. */
  message: string;
}

/** Exact semver, optionally with prerelease/build metadata. Deliberately anchored at both ends. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const INTEGRITY = /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/;
const OCI_DIGEST = /^sha256:[0-9a-f]{64}$/;

/** Range operators and dist-tags: everything that makes an identifier a query rather than a name. */
const RANGE_MARKERS = /[\^~*><=|\s]|\.x$|^x$|^latest$|^next$|^beta$|^alpha$|^canary$/i;

/**
 * The only way to produce a PinnedAgentArtifact.
 *
 * Configuration is supplied as a single string so it can live in one environment variable:
 *
 *     npm:@diffci/observer@1.4.2#sha512-BASE64...
 *     oci:ghcr.io/diffci/observer@sha256:<64 hex>
 *
 * Rejects rather than repairs. A dist-tag is not resolved to the version it currently points at, and
 * a version without an integrity hash is not looked up: both would mean asking the registry what it
 * thinks right now, and enshrining an answer that could differ from the one the customer's runner
 * gets later - the same mutability problem wearing a different hat.
 */
export function parseAgentArtifact(raw: string | undefined | null): ParsedArtifact | RejectedArtifact {
  if (raw === undefined || raw === null || raw.trim() === "") {
    return { ok: false, rejection: "missing", message: "DIFFCI_AGENT_ARTIFACT is not set. Installation instructions cannot be generated without a pinned, integrity-verifiable agent artifact." };
  }

  const value = raw.trim();
  const separator = value.indexOf(":");
  if (separator <= 0) return { ok: false, rejection: "malformed", message: `"${value}" does not start with an artifact kind, e.g. "npm:" or "oci:".` };

  const kind = value.slice(0, separator);
  const rest = value.slice(separator + 1);
  if (kind === "npm") return parseNpm(rest, value);
  if (kind === "oci") return parseOci(rest, value);
  return { ok: false, rejection: "malformed", message: `"${kind}" is not a supported artifact kind. Supported: npm, oci.` };
}

function parseNpm(rest: string, original: string): ParsedArtifact | RejectedArtifact {
  const hash = rest.indexOf("#");
  if (hash === -1) {
    return { ok: false, rejection: "not_verifiable", message: `"${original}" carries no integrity hash. Append "#sha512-..." so the customer's package manager can verify the bytes it received.` };
  }

  const spec = rest.slice(0, hash);
  const integrity = rest.slice(hash + 1);

  // lastIndexOf, because a scoped name contains its own "@" at position 0.
  const at = spec.lastIndexOf("@");
  if (at <= 0) return { ok: false, rejection: "malformed", message: `"${original}" is not of the form npm:<name>@<version>#<integrity>.` };

  const name = spec.slice(0, at);
  const version = spec.slice(at + 1);
  if (!NPM_NAME.test(name)) return { ok: false, rejection: "malformed", message: `"${name}" is not a valid npm package name.` };

  if (RANGE_MARKERS.test(version) || !EXACT_VERSION.test(version)) {
    return {
      ok: false,
      rejection: "not_immutable",
      message: `"${version}" is not an exact version. A range or dist-tag resolves to whatever is newest when the customer's CI installs it, so the code running in their pipeline could change without their repository changing.`,
    };
  }

  if (!INTEGRITY.test(integrity)) {
    return { ok: false, rejection: "not_verifiable", message: `"${integrity}" is not a valid subresource-integrity value (expected sha512-<base64>).` };
  }

  return { ok: true, artifact: { kind: "npm", name, version, integrity, display: `${name}@${version}` } as PinnedNpmArtifact };
}

function parseOci(rest: string, original: string): ParsedArtifact | RejectedArtifact {
  const at = rest.lastIndexOf("@");
  if (at <= 0) {
    return { ok: false, rejection: rest.includes(":") ? "not_immutable" : "malformed", message: `"${original}" must address the image by digest, e.g. oci:registry/image@sha256:<64 hex>. A tag can be repointed after installation.` };
  }
  const image = rest.slice(0, at);
  const digest = rest.slice(at + 1);
  if (!OCI_DIGEST.test(digest)) {
    return { ok: false, rejection: "not_immutable", message: `"${digest}" is not a sha256 digest. A tag is not an identifier: it can be moved to different bytes at any time.` };
  }
  // A digest IS the integrity check for an OCI artifact - the content is addressed by its own hash -
  // so there is no separate integrity field to require here.
  return { ok: true, artifact: { kind: "oci", image, digest, display: `${image}@${digest.slice(0, 19)}...` } as PinnedOciArtifact };
}

/** Convenience for callers that only need "is this environment able to onboard anyone", e.g. /health. */
export function isPinnedAgentArtifact(raw: string | undefined | null): boolean {
  return parseAgentArtifact(raw).ok;
}
