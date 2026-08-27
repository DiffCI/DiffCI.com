/**
 * The Windows migration fix, and the safety property it depends on (2026-08-27).
 *
 * BACKGROUND. `npm run product:migrate` could never actually run on Windows: Node >=18.20/20.12
 * refuses to spawn a `.cmd` shim directly (the CVE-2024-27980 mitigation) and throws EINVAL, so
 * `execFileSync("npx.cmd", ...)` failed before the first schema file was applied. The fix passes
 * `shell: true` on win32 only.
 *
 * WHY THAT NEEDS A TEST. `shell: true` changes the argument model from execve-style (an argv array the
 * OS receives verbatim) to string concatenation through cmd.exe, where a space splits an argument and
 * `&`, `|`, `^`, `>` and friends are operators. That is safe here for one reason and one reason only:
 * every argument is a compile-time constant in this repository, so nothing an attacker controls is ever
 * concatenated. That reason is a property of the data, so it is asserted here rather than trusted to a
 * comment - if someone later adds a schema path with a space in it, or makes the file list dynamic,
 * this fails instead of silently becoming an injection point.
 */
import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { MIGRATION_FILES, MIGRATION_ARGUMENT_LITERALS } from "../../scripts/migrate-product-db.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptPath = join(repoRoot, "scripts", "migrate-product-db.ts");

/** Anything cmd.exe or a POSIX shell would treat as other than a literal character. */
const SHELL_METACHARACTERS = /[\s&|<>^"'`$();!*?\[\]{}~#\\]/;

describe("migrate-product-db argument safety", () => {
  it("passes no argument that a shell would reinterpret", () => {
    for (const file of MIGRATION_FILES) {
      assert.equal(SHELL_METACHARACTERS.test(file), false, `migration path "${file}" contains a shell metacharacter and cannot be passed with shell:true`);
    }
    for (const literal of MIGRATION_ARGUMENT_LITERALS) {
      assert.equal(SHELL_METACHARACTERS.test(literal), false, `argument literal "${literal}" contains a shell metacharacter`);
    }
  });

  it("builds --file= arguments that are still metacharacter-free once concatenated", () => {
    // The argument actually passed is `--file=<path>`, not the bare path, so assert the composed form.
    for (const file of MIGRATION_FILES) {
      assert.equal(SHELL_METACHARACTERS.test(`--file=${file}`), false);
    }
  });

  it("takes no argument from the environment, argv, or any network source", () => {
    const source = readFileSync(scriptPath, "utf8");
    // `mode` is chosen from argv, but only ever as one of two fixed strings - a value is never copied
    // out of argv into the command. Assert that the only argv reads are the includes() checks and the
    // entry-point guard, so a future edit that forwards user input becomes visible here.
    const argvReads = source.match(/process\.argv/g) ?? [];
    assert.equal(argvReads.length, 4, "process.argv is read exactly for --remote, --local, and the entry-point guard");
    assert.equal(source.includes("process.env"), false, "no environment value is interpolated into the command");
  });

  it("scopes shell:true to win32, so POSIX keeps real execve semantics", () => {
    // Comments are stripped first: the file explains the fix in prose, and prose describing
    // `shell:true` is not the same thing as code setting it.
    const code = readFileSync(scriptPath, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    assert.match(code, /shell:\s*process\.platform === "win32"/);
    // Not unconditional: on Linux/macOS `npx` is a real executable needing no shell, so the
    // concatenation risk is not taken on the platforms that do not require it.
    assert.equal(/shell:\s*true/.test(code), false);
  });
});

describe("migration file list", () => {
  it("names files that all exist, so a migration cannot half-apply and then fail on a typo", () => {
    for (const file of MIGRATION_FILES) {
      assert.equal(existsSync(join(repoRoot, file)), true, `${file} is listed as a migration but does not exist`);
    }
  });

  it("contains only idempotent DDL, because the runner has no version table and re-runs everything", () => {
    for (const file of MIGRATION_FILES) {
      const sql = readFileSync(join(repoRoot, file), "utf8");
      const creates = sql.match(/CREATE\s+(TABLE|INDEX|VIEW|TRIGGER)/gi) ?? [];
      const guarded = sql.match(/CREATE\s+(TABLE|INDEX|VIEW|TRIGGER)\s+IF\s+NOT\s+EXISTS/gi) ?? [];
      assert.equal(creates.length, guarded.length, `${file} has a CREATE without IF NOT EXISTS; re-running the migration would fail`);
      assert.equal(/^\s*DROP\s+/im.test(sql), false, `${file} contains a DROP - the migration runner is re-run against live production data`);
    }
  });

  it("orders every referenced table before the file that references it", () => {
    const created = new Set<string>();
    for (const file of MIGRATION_FILES) {
      const sql = readFileSync(join(repoRoot, file), "utf8");
      for (const match of sql.matchAll(/REFERENCES\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gi)) {
        const table = match[1]!.toLowerCase();
        // Self-references inside the same file are fine - the table exists by the time the FK is used.
        const selfDefined = new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${table}\\b`, "i").test(sql);
        assert.equal(created.has(table) || selfDefined, true, `${file} references ${table} before any earlier migration creates it`);
      }
      for (const match of sql.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/gi)) {
        created.add(match[1]!.toLowerCase());
      }
    }
  });
});
