import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { runSyntheticFailureCase, cleanupSyntheticRepo, SYNTHETIC_CASES } from "../../src/shadow/synthetic-fixtures.js";

describe("synthetic failure corpus", () => {
  for (const caseName of Object.keys(SYNTHETIC_CASES) as Array<keyof typeof SYNTHETIC_CASES>) {
    it(`[SYNTHETIC SAFETY EVIDENCE] ${caseName} selects the affected test`, async () => {
      const result = await runSyntheticFailureCase(caseName);
      try {
        assert.ok(
          result.selectedTests.length > 0,
          `expected DiffCI to select at least one test for ${caseName}, got ${JSON.stringify(result.selectedTests)}`,
        );
        assert.ok(result.plan.safety.fallbackRequired === false, `expected SELECTIVE mode in ${caseName}`);
      } finally {
        cleanupSyntheticRepo(result);
      }
    });
  }
});
