/**
 * EXTERNAL_ENGINE_BRIDGE_01. A reference plan is hand-transcribed by reading a repository's own
 * workflow — deliberately never auto-generated, so the reference arm stays independently constructed
 * from the inference arm (docs/ci-reproduction-01-protocol.md, semantic-repair-01-plan.md). Before this
 * fix, `main()` crashed uncaught (readFileSync -> ENOENT) for any repository without one, writing no
 * `reproduction.json` at all — indistinguishable from an infrastructure failure. These are behavioural,
 * subprocess-level tests: `main()` is intentionally unexported (see ci-reproduction.ts's own comment on
 * why), so exercising the real CLI entrypoint is the only way to verify what it actually does.
 *
 * Spawned via `node <tsx's own CLI module> <script> <args>` rather than `npx`/a shell string, so this
 * runs identically on Windows and Linux without either a shell-quoting dependency (this repo's own path
 * contains a space) or an `npx`/`npx.cmd` PATH-resolution difference between platforms.
 *
 * Both branches return before any clone or network access, so these run fast and offline.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const TSX_CLI = require.resolve("tsx/cli");
const SCRIPT = join(process.cwd(), "scripts/ci-reproduction.ts");
const NONEXISTENT_REFERENCE = join(process.cwd(), "docs/evidence/ci-reproduction-05-does-not-exist-reference-plan.json");

function runCiReproduction(args: string[]): void {
  // Exit code must be 0: an unhandled exception would be indistinguishable from an infrastructure
  // failure to any caller, which is exactly the failure mode this fix exists to remove.
  execFileSync(process.execPath, [TSX_CLI, SCRIPT, ...args], { stdio: "pipe" });
}

test("a missing reference plan is an honest, persisted REFUSED - never a crash", () => {
  const outDir = mkdtempSync(join(tmpdir(), "diffci-missing-reference-plan-"));
  try {
    runCiReproduction(["--repository", "some-org/some-repo", "--head", "0".repeat(40), "--reference", NONEXISTENT_REFERENCE, "--out", outDir]);

    const reproduction = JSON.parse(readFileSync(join(outDir, "reproduction.json"), "utf8"));
    assert.equal(reproduction.outcome, "REFUSED");
    assert.equal(reproduction.repository, "some-org/some-repo");
    assert.match(reproduction.reason, /no reference plan exists/);
    assert.match(reproduction.reason, /hand-transcribed/);
    // The absence must read as "not yet prepared", never as a defect DiffCI's own engine caused.
    assert.doesNotMatch(reproduction.reason, /ENOENT|no such file|stack/i);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("the same is true for R3 (--reference-only) qualification", () => {
  const outDir = mkdtempSync(join(tmpdir(), "diffci-missing-reference-plan-r3-"));
  try {
    runCiReproduction(["--repository", "some-org/some-repo", "--head", "0".repeat(40), "--reference", NONEXISTENT_REFERENCE, "--out", outDir, "--reference-only"]);

    const r3 = JSON.parse(readFileSync(join(outDir, "reproduction.json"), "utf8"));
    assert.equal(r3.verdict, "R3_FAILED");
    assert.equal(r3.engineInvoked, false);
    assert.match(r3.reason, /no reference plan exists/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
