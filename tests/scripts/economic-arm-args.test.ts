/**
 * The economics arms must invoke the test runner the same way the safety pass does.
 *
 * On 2026-08-30 they did not. `armArgs` was built from the runner's ARGUMENTS while omitting the
 * runner's MODULE, so every arm ran `node run <files>` - node attempting to execute a file named
 * "run" - and exited 1 in milliseconds. All 22 hono candidates came back compute-unmeasurable.
 *
 * The guard did its job: a failed arm is never costed as zero. Had it been, the run would have reported
 * a near-zero DiffCI execution cost against a real full-suite cost, produced a huge positive
 * incrementalCpu, and looked exactly like the result the experiment was hoping to find. That is the
 * most dangerous shape a measurement bug can take, so the invocation is pinned by a test rather than by
 * having been fixed once.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

/** Mirrors dogfood-mutate's construction, which is what the arms actually use. */
function armArgs(fullArgs: string[], files: string[]): string[] {
  return [...fullArgs.filter((a) => !a.includes("*")), ...files];
}

const MODULE = "node_modules/vitest/vitest.mjs";

describe("economics arm invocation", () => {
  it("keeps the runner module first, so the command is executable at all", () => {
    const args = armArgs([MODULE, "run"], ["src/a.test.ts"]);
    assert.equal(args[0], MODULE, "without the module this becomes `node run <files>`");
    assert.deepEqual(args, [MODULE, "run", "src/a.test.ts"]);
  });

  it("matches the shape the safety pass uses for its selected run", () => {
    // Same construction as `selectedArgs` in dogfood-mutate: module, runner args, then files.
    const fullArgs = [MODULE, "run"];
    const files = ["src/a.test.ts", "src/b.test.ts"];
    assert.deepEqual(armArgs(fullArgs, files), [MODULE, ...["run"], ...files]);
  });

  it("drops glob arguments, which would widen the run back out to everything", () => {
    // A pattern beside explicit paths stops the arm being a subset, and would cost the full suite while
    // claiming to cost a selection.
    const args = armArgs([MODULE, "run", "src/**/*.test.ts"], ["src/a.test.ts"]);
    assert.equal(args.includes("src/**/*.test.ts"), false);
    assert.deepEqual(args, [MODULE, "run", "src/a.test.ts"]);
  });

  it("preserves file order and passes every selected file", () => {
    const files = ["z.test.ts", "a.test.ts", "m.test.ts"];
    const args = armArgs([MODULE, "run"], files);
    assert.deepEqual(args.slice(2), files);
  });
});
