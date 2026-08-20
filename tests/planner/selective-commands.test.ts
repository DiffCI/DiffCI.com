import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { commandSpecToString, generateSelectiveTestCommandSpecs, groupTestPaths } from "../../src/planner/selective-commands.js";

describe("selective-commands", () => {
  it("groups TS source tests under tsx", () => {
    const specs = generateSelectiveTestCommandSpecs(["src/foo.test.ts", "src/bar.spec.ts"]);
    assert.deepEqual(specs, [
      {
        executable: "tsx",
        args: ["--conditions", "react-server", "--test", "src/foo.test.ts", "src/bar.spec.ts"],
      },
    ]);
  });

  it("groups ops tests under a separate tsx invocation", () => {
    const groups = groupTestPaths(["ops/deploy.test.ts", "src/foo.test.ts"]);
    assert.equal(groups.length, 2);
    const ops = groups.find((g) => g.runnerId === "ops");
    assert.ok(ops);
    assert.deepEqual(ops!.commandSpec.args.slice(0, 2), ["--test", "ops/deploy.test.ts"]);
  });

  it("groups scripts and .mjs/.js tests under node", () => {
    const groups = groupTestPaths(["scripts/audit.test.mjs", "ops/install.test.js"]);
    assert.equal(groups.length, 2);
    assert.ok(groups.every((g) => g.commandSpec.executable === "node"));
  });

  it("escapes paths safely when formatted", () => {
    const specs = generateSelectiveTestCommandSpecs(["src/foo bar.test.ts", 'src/quote"test.ts']);
    const formatted = commandSpecToString(specs[0]!);
    assert.ok(!formatted.includes("src/foo bar.test.ts"));
    assert.ok(formatted.includes('"'));
    assert.ok(!formatted.includes(";"));
    assert.ok(!formatted.includes("|"));
  });

  it("returns no commands for an empty test selection", () => {
    assert.deepEqual(generateSelectiveTestCommandSpecs([]), []);
  });
});
