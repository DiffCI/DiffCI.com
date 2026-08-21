/**
 * Shared packaging/upload logic for the shadow source archive (2026-08-21 source-integrity fix) - used
 * by both scripts/upload-shadow-source.ts (a thin standalone CLI, kept for manual re-upload/debugging)
 * and scripts/deploy-research-sandbox.ts (the canonical full deploy pipeline). Extracted rather than
 * duplicated so there is exactly one place that decides what "the source SHA" and "the packaged bytes"
 * mean - the whole point of this fix is that those can no longer drift apart or be redefined ad hoc per
 * call site.
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isValidSha } from "../src/research/cloudflare/shadow-source-integrity.js";

export { isValidSha };

/** The exact git commit the working tree currently reflects. Deliberately the ONLY source of a
 * `sourceSha` value anywhere in this pipeline - never a CLI flag, never a free-text label - see the
 * module doc comment on shadow-source-integrity.ts for why a manually-suppliable value would defeat the
 * whole invariant. */
export function currentHeadSha(repoRoot: string): string {
  const sha = execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();
  if (!isValidSha(sha)) throw new Error(`git rev-parse HEAD returned something that isn't a full SHA: "${sha}"`);
  return sha;
}

/** True if the working tree has uncommitted changes (tracked or untracked) - `git status --porcelain`
 * lists both, which is exactly what matters here: an untracked file would still end up inside the
 * tarball (the tar step below only excludes node_modules/.git/.diffci/dist, nothing else) even though it
 * isn't part of the commit `currentHeadSha` names. Packaging a dirty tree under a clean commit's SHA
 * would make that SHA a lie about what's actually running - the exact "manually supplied arbitrary
 * label" failure mode this fix exists to close, just introduced a different way. */
export function isWorkingTreeDirty(repoRoot: string): boolean {
  const status = execSync("git status --porcelain", { cwd: repoRoot, encoding: "utf8" });
  return status.trim().length > 0;
}

export interface PackagedSource {
  tarballPath: string;
  sourceSha: string;
  archiveHash: string;
  sizeBytes: number;
  cleanup(): void;
}

/**
 * Packages the current working tree into a tarball and computes both identity values the upload endpoint
 * requires: `sourceSha` (the commit) and `archiveHash` (a SHA-256 of the tarball's own bytes, so the
 * receiving end can detect transport corruption independent of git entirely). Refuses a dirty working
 * tree unless `allowDirty` is explicitly passed - see isWorkingTreeDirty's comment for why that matters -
 * in which case the returned `sourceSha` is still HEAD, but the caller is trusting that the untracked/
 * uncommitted delta doesn't matter for this particular use (local debugging only; never the canonical
 * deploy path, which never passes this flag).
 */
export function packageSource(repoRoot: string, options: { allowDirty?: boolean } = {}): PackagedSource {
  if (!options.allowDirty && isWorkingTreeDirty(repoRoot)) {
    throw new Error(
      "working tree has uncommitted changes - refusing to package it under a commit SHA that wouldn't " +
        "actually match the packaged bytes. Commit (or stash) first, or pass --allow-dirty for local-only debugging.",
    );
  }
  const sourceSha = currentHeadSha(repoRoot);

  mkdirSync(join(repoRoot, ".diffci"), { recursive: true });
  // A RELATIVE output path inside the already-excluded .diffci/ dir - an absolute Windows path (C:\...)
  // makes MSYS GNU tar treat "C" as a remote hostname, and bsdtar/GNU-tar disagree on --force-local; a
  // relative path works in both (same reasoning as the original upload-shadow-source.ts).
  const tarballRelPath = ".diffci/shadow-source-upload.tgz";
  const tarballPath = join(repoRoot, tarballRelPath);
  execSync(`tar --exclude=node_modules --exclude=.git --exclude=.diffci --exclude=dist -czf ${tarballRelPath} .`, {
    cwd: repoRoot,
    stdio: "inherit",
  });
  const bytes = readFileSync(tarballPath);
  const archiveHash = createHash("sha256").update(bytes).digest("hex");

  return {
    tarballPath,
    sourceSha,
    archiveHash,
    sizeBytes: bytes.byteLength,
    cleanup: () => rmSync(tarballPath, { force: true }),
  };
}

export interface UploadResult {
  ok: boolean;
  sourceSha?: string;
  archiveHash?: string;
  uploadedAt?: string;
  sizeBytes?: number;
  archiveKey?: string;
  error?: string;
}

/** POSTs an already-packaged archive to /v1/shadow/source. Pure I/O, no packaging logic - kept separate
 * from packageSource so a caller that already has a tarball (or wants to retry just the upload half of a
 * failed deploy) doesn't have to re-tar. */
export async function uploadPackagedSource(options: {
  url: string;
  token: string;
  packaged: PackagedSource;
  label?: string;
}): Promise<UploadResult> {
  const bytes = readFileSync(options.packaged.tarballPath);
  const form = new FormData();
  form.set("source", new File([bytes], "diffci-source.tgz"), "diffci-source.tgz");
  form.set("sourceSha", options.packaged.sourceSha);
  form.set("archiveHash", options.packaged.archiveHash);
  form.set("label", options.label ?? options.packaged.sourceSha.slice(0, 7));

  const res = await fetch(`${options.url.replace(/\/$/, "")}/v1/shadow/source`, {
    method: "POST",
    headers: { Authorization: `Bearer ${options.token}` },
    body: form,
  });
  const body = await res.text();
  if (!res.ok) {
    return { ok: false, error: `upload failed (${res.status}): ${body.slice(0, 500)}` };
  }
  try {
    return { ok: true, ...(JSON.parse(body) as Record<string, unknown>) };
  } catch {
    return { ok: false, error: `upload succeeded but response wasn't valid JSON: ${body.slice(0, 500)}` };
  }
}
