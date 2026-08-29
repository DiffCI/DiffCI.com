/**
 * One execution primitive, enforced rather than intended.
 *
 * THE INVARIANT: the two scripts that produce evidence - qualification and mutation - must spawn
 * processes only through `scripts/process-exec.ts`.
 *
 * WHY IT IS A TEST AND NOT A CONVENTION. The calibration suite measures `execBounded`: that a bound
 * holds, that a killed process is never green, that a surviving grandchild does not escape the timeout.
 * Those measurements transfer to an experiment ONLY if the experiment runs through the same code. A
 * second `spawnSync` call somewhere in the harness would be certified by nothing, and the divergence
 * would be invisible - which is not hypothetical here: `dogfood-mutate` carried two different
 * definitions of the child environment, and the one that executed TEST SUITES was the reduced one.
 *
 * Other scripts may call spawnSync freely. Packers, builders and CLI drivers do not produce
 * classifications, and nothing downstream rests on their process semantics.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";

const repoRoot = resolve(dirname(import.meta.filename), "..", "..");

/** The scripts whose output becomes evidence. */
const EVIDENCE_PRODUCING = ["scripts/dogfood-qualify.ts", "scripts/dogfood-mutate.ts"];

describe("the evidence-producing scripts share one calibrated execution primitive", () => {
  for (const relative of EVIDENCE_PRODUCING) {
    it(`${relative} spawns nothing directly`, () => {
      const source = readFileSync(join(repoRoot, relative), "utf8");

      assert.equal(
        /\bspawnSync\s*\(/.test(source),
        false,
        `${relative} calls spawnSync directly. Route it through execBounded so the calibration suite's ` +
          `measurements actually apply to it.`,
      );
      assert.equal(
        /from "node:child_process"/.test(source),
        false,
        `${relative} imports node:child_process directly.`,
      );
      assert.ok(
        /from "\.\/process-exec\.js"/.test(source),
        `${relative} must import its execution primitive from ./process-exec.js`,
      );
    });

    it(`${relative} defines no environment of its own`, () => {
      const source = readFileSync(join(repoRoot, relative), "utf8");
      // The non-interactive environment belongs to the primitive. A local copy is how the mutation
      // path came to run test suites without corepack's prompt suppression while the install path
      // beside it had it.
      assert.equal(
        /const NON_INTERACTIVE_ENV\s*=/.test(source),
        false,
        `${relative} declares its own NON_INTERACTIVE_ENV; process-exec.ts owns it.`,
      );
    });
  }

  it("the primitive itself is the only place spawnSync appears among these", () => {
    const primitive = readFileSync(join(repoRoot, "scripts", "process-exec.ts"), "utf8");
    assert.ok(/\bspawnSync\s*\(/.test(primitive), "process-exec.ts is where spawning is supposed to live");
  });
});
