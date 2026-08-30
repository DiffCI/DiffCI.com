/**
 * Which arguments get stripped from a subset run.
 *
 * The filter exists so a file glob cannot sit beside explicit paths and widen the run back out to
 * everything - costing the full suite while claiming to cost a selection.
 *
 * It must not strip FLAG VALUES that happen to contain a star. `vitest --project unit*` is vuejs/core's
 * own documented unit-test invocation; stripping `unit*` would leave `--project` to swallow the next
 * argument, which is a test file path. The command would be mangled rather than narrowed, and because
 * the FULL arm does not strip, the arms would stop being comparable while still producing numbers.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

/** Mirrors the predicate in dogfood-mutate. */
function isFileGlob(arg: string): boolean {
  if (!arg.includes("*")) return false;
  return arg.includes("**") || /\.\w+$/.test(arg);
}

describe("file-glob filtering for subset runs", () => {
  it("strips patterns that would widen the run back to everything", () => {
    for (const pattern of ["src/**/*.test.ts", "**/*.spec.js", "packages/*/__tests__/*.ts", "test/*.test.tsx"]) {
      assert.equal(isFileGlob(pattern), true, `${pattern} should be stripped`);
    }
  });

  it("keeps flag values that merely contain a star", () => {
    // The vuejs/core case. Stripping this mangles the command instead of narrowing it.
    for (const value of ["unit*", "e2e*", "@vitest/test-*", "unit"]) {
      assert.equal(isFileGlob(value), false, `${value} is a value, not a path`);
    }
  });

  it("keeps ordinary flags and explicit file paths untouched", () => {
    for (const arg of ["run", "--project", "--no-isolate", "src/a.test.ts", "node_modules/vitest/vitest.mjs"]) {
      assert.equal(isFileGlob(arg), false, `${arg} must survive`);
    }
  });

  it("leaves --project and its value adjacent, which is what the old filter broke", () => {
    const args = ["node_modules/vitest/vitest.mjs", "run", "--project", "unit*"];
    const kept = args.filter((a) => !isFileGlob(a));
    assert.deepEqual(kept, args);
    assert.equal(kept[kept.indexOf("--project") + 1], "unit*", "the flag must still own its value");
  });
});
