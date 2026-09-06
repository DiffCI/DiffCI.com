/**
 * action.yml is loaded by GitHub's template engine, which evaluates `${{ }}` expressions EVERYWHERE in
 * the file - descriptions included - against the contexts an action may use. `secrets` is not one of
 * them. A literal `${{ secrets.DIFFCI_TOKEN }}` inside an input description made the action refuse to
 * load on every run from its creation (2026-08-26) until 2026-09-06, hidden behind continue-on-error.
 * This test pins the rule: no expression anywhere in action.yml may name a context an action cannot see,
 * and free text (descriptions) may not contain expressions at all.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const ACTION_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../action.yml");

// Contexts a composite action's metadata may reference. `secrets`, `needs`, `job`, `strategy`,
// `matrix` belong to the calling workflow and are unrecognized inside action.yml.
const ALLOWED_CONTEXTS = new Set(["inputs", "github", "env", "steps", "runner"]);

function expressions(text: string): string[] {
  return [...text.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map((m) => m[1]!.trim());
}

function walkDescriptions(node: unknown, path: string, out: Array<{ path: string; text: string }>): void {
  if (Array.isArray(node)) node.forEach((n, i) => walkDescriptions(n, `${path}[${i}]`, out));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "description" && typeof v === "string") out.push({ path: `${path}.${k}`, text: v });
      else walkDescriptions(v, `${path}.${k}`, out);
    }
  }
}

describe("action.yml metadata", () => {
  const raw = readFileSync(ACTION_PATH, "utf8");
  const doc = parse(raw) as Record<string, unknown>;

  it("names no context an action file cannot see, anywhere in the file", () => {
    for (const expr of expressions(raw)) {
      const contexts = [...expr.matchAll(/(?<![\w.'])([a-zA-Z_]+)\s*\./g)].map((m) => m[1]!);
      for (const c of contexts) assert.ok(ALLOWED_CONTEXTS.has(c), `expression "${expr}" uses context "${c}", which GitHub rejects inside action.yml`);
    }
  });

  it("has no expression inside any description - GitHub evaluates those too", () => {
    const descriptions: Array<{ path: string; text: string }> = [];
    walkDescriptions(doc, "action", descriptions);
    assert.ok(descriptions.length >= 10, "sanity: the inputs were parsed");
    for (const d of descriptions) assert.equal(expressions(d.text).length, 0, `${d.path} contains an expression: ${d.text}`);
  });

  it("is a composite action whose token reaches the observer only through the environment", () => {
    const runs = doc.runs as { using: string; steps: Array<{ id?: string; env?: Record<string, string>; run?: string }> };
    assert.equal(runs.using, "composite");
    const observe = runs.steps.find((s) => s.id === "observe");
    assert.ok(observe, "observe step present");
    assert.equal(observe!.env?.DIFFCI_TOKEN, "${{ inputs.api-token }}");
    assert.doesNotMatch(observe!.run ?? "", /api-token|DIFFCI_TOKEN/, "the token is never placed on a command line");
  });
});
