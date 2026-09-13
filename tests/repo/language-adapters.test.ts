import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { buildDependencyGraph, classifyRepositoryProject, refineConfidenceForDelta } from "../../src/repo/graph.js";
import { ImpactAnalyzer } from "../../src/repo/impact.js";
import { planSelectiveTestCommands } from "../../src/planner/test-command.js";
import { parseGoList, analyzeGoMetadata, goAdapter } from "../../src/repo/adapters/go.js";
import { vueAdapter } from "../../src/repo/adapters/vue.js";
import { parseGoTestOutput } from "../../src/repo/adapters/go-test.js";
import { analyzeRepository } from "../../src/repo/analyzer.js";
import { observe } from "../../src/client/observe.js";
import type { GitDelta } from "../../src/git/types.js";
import { compileScript, compileTemplate, parse } from "@vue/compiler-sfc";

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "diffci-adapters-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}
function delta(path: string): GitDelta {
  return {
    baseSha: "base", headSha: "head", files: [{ path, changeType: "modified" }], directories: [],
    summary: { total: 1, added: 0, modified: 1, deleted: 0, renamed: 0, copied: 0, unmerged: 0, unknown: 0 },
    analysis: { empty: false, configChanged: false, dependencyManifestChanged: false, lockfileChanged: false, workflowChanged: false, infrastructureChanged: false, databaseChanged: false },
  };
}
const jsBase = {
  "package.json": JSON.stringify({ devDependencies: { vitest: "1" } }),
  "tsconfig.json": JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler", target: "ES2022" }, include: ["src", "tests"] }),
  "src/value.ts": "export const value = 1;",
  "src/Child.vue": '<script setup lang="ts">import { value } from "./value";</script><template><span>{{ value }}</span></template>',
  "src/Parent.vue": '<script setup lang="ts">import Child from "./Child.vue";</script><template><Child /></template>',
  "tests/component.test.ts": 'import Parent from "../src/Parent.vue"; export const subject = Parent;',
  "tests/unrelated.test.ts": "export const unrelated = 1;",
};

test("Vue resolves aliased macro types through extended tsconfig and refreshes compiler configuration", () => {
  const root = fixture({
    "package.json": "{}",
    "tsconfig.json": '{"extends":["./tsconfig.app.json"],"files":[]}',
    "tsconfig.app.json": '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}',
    "src/props.ts": "export interface Props { value: string }",
    "alt/props.ts": "export interface Props { value: number }",
    "App.vue": '<script setup lang="ts">import type { Props } from "@/props"; defineProps<Props>();</script>',
  });
  try {
    for (const [directory, runtime] of [["src", "String"], ["alt", "Number"]]) {
      writeFileSync(join(root, "tsconfig.app.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": [`${directory}/*`] } } }));
      const result = vueAdapter.analyze({ repoPath: root, files: ["App.vue"], profile: analyzeRepository({ repoPath: root }) });
      assert.deepEqual(result.blockers, []);
      assert.ok(result.edges.some(edge => edge.to === `${directory}/props.ts`));
      assert.ok(result.virtualSources[0].source.includes(`type: ${runtime}`));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Vue transitive source and component changes select only importing tests", async () => {
  const root = fixture(jsBase);
  try {
    const result = await buildDependencyGraph({ repoPath: root });
    assert.deepEqual(result.adapterBlockers, []);
    assert.equal(result.confidence, "COMPLETE");
    assert.ok(result.graph.dependenciesOf("src/Parent.vue").includes("src/Child.vue"));
    for (const path of ["src/value.ts", "src/Child.vue", "src/Parent.vue"]) {
      const impact = new ImpactAnalyzer().analyze(delta(path), result, result.profile);
      assert.equal(impact.fallbackRequired, false, impact.fallbackReasons.join("; "));
      assert.deepEqual(impact.affectedTests.map((test) => test.path), ["tests/component.test.ts"]);
      assert.equal(planSelectiveTestCommands(result.profile, impact.affectedTests.map((test) => test.path)).groups[0].runnerId, "vitest");
    }
    assert.equal(new ImpactAnalyzer().analyze(delta("vite.config.ts"), result, result.profile).fallbackRequired, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Vue unsupported templates, styles and malformed SFCs remain globally unsafe", async () => {
  for (const source of [
    '<template><UnknownComponent /></template>',
    '<template><component :is="name" /></template>',
    '<template><span /></template><style>@import "./shared.css";</style>',
    '<template><span></template>',
    '<template lang="pug">span hello</template>',
  ]) {
    const root = fixture({ ...jsBase, "src/Unsupported.vue": source });
    try {
      const result = await buildDependencyGraph({ repoPath: root });
      assert.ok(result.adapterBlockers!.length);
      assert.equal(refineConfidenceForDelta(result, ["tests/unrelated.test.ts"]), "UNSAFE");
      assert.equal(new ImpactAnalyzer().analyze(delta("tests/unrelated.test.ts"), result, result.profile).fallbackRequired, true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("Vue literal Options API registrations preserve transitive dependencies", async () => {
  const root = fixture({ ...jsBase,
    "src/Empty.vue": '<script setup lang="ts"></script>',
    "src/Parent.vue": '<script lang="ts">import { defineComponent } from "vue"; import Child from "./Child.vue"; export default defineComponent({components: { Child }})</script><template><Child /></template>',
  });
  try {
    const graph = await buildDependencyGraph({ repoPath: root });
    assert.deepEqual(graph.adapterBlockers, []);
    const impact = new ImpactAnalyzer().analyze(delta("src/value.ts"), graph, graph.profile);
    assert.equal(impact.fallbackRequired, false);
    assert.deepEqual(impact.affectedTests.map(t => t.path), ["tests/component.test.ts"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Vue spread or computed registrations cannot hide runtime dependencies", async () => {
  for (const options of ['components: { Child, ...registry }', '...options, components: { Child }', 'components: { [name]: Child }']) {
    const root = fixture({ ...jsBase, "src/Parent.vue": `<script>import Child from './Child.vue'; export default {${options}}</script><template><Child /></template>` });
    try { assert.ok((await buildDependencyGraph({ repoPath: root })).adapterBlockers?.length); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("Vue without tsconfig still parses transitive JavaScript dependencies and test imports", async () => {
  const root = fixture({
    "package.json": JSON.stringify({ devDependencies: { vitest: "1" } }),
    "src/value.js": "export const value = 1;",
    "src/helper.js": 'export { value } from "./value.js";',
    "src/App.vue": '<script setup>import { value } from "./helper.js";</script><template>{{ value }}</template>',
    "tests/app.test.js": 'import App from "../src/App.vue"; export const app = App;',
  });
  try {
    const result = await buildDependencyGraph({ repoPath: root });
    assert.equal(classifyRepositoryProject(root).capable, true);
    assert.deepEqual(result.adapterBlockers, []);
    const impact = new ImpactAnalyzer().analyze(delta("src/value.js"), result, result.profile);
    assert.equal(impact.fallbackRequired, false);
    assert.deepEqual(impact.affectedTests.map((test) => test.path), ["tests/app.test.js"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Vue imported macro types retain runtime dependency edges", async () => {
  const root = fixture({ ...jsBase,
    "src/props.ts": "export interface Props { title: string }",
    "src/Child.vue": '<script setup lang="ts">import type { Props } from "./props"; defineProps<Props>();</script><template><span>{{ title }}</span></template>',
  });
  try {
    const result = await buildDependencyGraph({ repoPath: root });
    assert.deepEqual(result.adapterBlockers, []);
    assert.ok(result.graph.dependenciesOf("src/Child.vue").includes("src/props.ts"));
    const impact = new ImpactAnalyzer().analyze(delta("src/props.ts"), result, result.profile);
    assert.equal(impact.fallbackRequired, false);
    assert.deepEqual(impact.affectedTests.map(t => t.path), ["tests/component.test.ts"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Vue shared macro types remain tracked and refresh across repeated analyses", () => {
  const component = '<script setup lang="ts">import type { Props } from "./props"; defineProps<Props>();</script>';
  const files = { "package.json": "{}", "props.ts": "export interface Props { value: string }", "One.vue": component, "Two.vue": component };
  const root = fixture(files);
  try {
    const context = { repoPath: root, files: Object.keys(files), profile: analyzeRepository({ repoPath: root }) };
    for (const [type, runtime] of [["string", "String"], ["number", "Number"]]) {
      writeFileSync(join(root, "props.ts"), `export interface Props { value: ${type} }`);
      const result = vueAdapter.analyze(context);
      assert.deepEqual(result.blockers, []);
      for (const path of ["One.vue", "Two.vue"]) {
        assert.ok(result.edges.some(edge => edge.from === path && edge.to === "props.ts"));
        assert.ok(result.virtualSources.find(source => source.path === path)?.source.includes(`type: ${runtime}`));
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Vue analysis preserves default compiler output without using source maps", () => {
  const components = {
    "Setup.vue": '<script setup lang="ts">import Child from "./Child.vue"; const props = defineProps<{ title: string }>();</script><template><Child>{{ props.title }}</Child></template>',
    "Options.vue": '<script>import Child from "./Child.vue"; export default { components: { Child } };</script><template><Child /></template>',
    "Asset.vue": '<template><img src="./logo.png" /></template>',
    "Runtime.vue": '<script setup>const name = "unknown";</script><template><component :is="name" /></template>',
    "Directive.vue": '<template><div v-custom /></template>',
  };
  const root = fixture({ "package.json": "{}", ...components });
  try {
    const context = { repoPath: root, files: Object.keys(components), profile: analyzeRepository({ repoPath: root }) };
    for (let repeat = 0; repeat < 2; repeat++) {
      const actual = vueAdapter.analyze(context);
      for (const [path, raw] of Object.entries(components)) {
        const { descriptor } = parse(raw, { filename: join(root, path) });
        const script = descriptor.script || descriptor.scriptSetup ? compileScript(descriptor, { id: path }) : undefined;
        const template = compileTemplate({ source: descriptor.template!.content, filename: path, id: path, compilerOptions: { bindingMetadata: script?.bindings } });
        assert.equal(actual.virtualSources.find(source => source.path === path)?.source, `${script?.content ?? ""}\n${template.code}`);
      }
      assert.deepEqual(actual.blockers, [
        "Vue Runtime.vue: runtime component/directive resolution requires full validation",
        "Vue Directive.vue: runtime component/directive resolution requires full validation",
      ]);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Go inactive files select their owning package and dependents without adding inactive tests", async (t) => {
  const root = fixture({ "go.mod": "module example\n",
    "lib/value.go": "package lib", "lib/value_windows.go": "package lib",
    "lib/value_test.go": "package lib", "lib/value_windows_test.go": "package lib",
    "app/app.go": "package app", "app/app_test.go": "package app",
    "other/other.go": "package other", "other/other_test.go": "package other",
    "_examples/main.go": "package main", "lib/testdata/fixture.go": "package fixture",
  });
  const output = [
    { Dir: join(root, "lib"), ImportPath: "example/lib", GoFiles: ["value.go"], TestGoFiles: ["value_test.go"], IgnoredGoFiles: ["value_windows.go", "value_windows_test.go"] },
    { Dir: join(root, "app"), ImportPath: "example/app", GoFiles: ["app.go"], TestGoFiles: ["app_test.go"], Imports: ["example/lib"] },
    { Dir: join(root, "other"), ImportPath: "example/other", GoFiles: ["other.go"], TestGoFiles: ["other_test.go"] },
  ].map(x => JSON.stringify(x)).join("\n");
  t.mock.method(goAdapter, "analyze", (context: Parameters<typeof analyzeGoMetadata>[0]) => analyzeGoMetadata(context, output));
  try {
    const graph = await buildDependencyGraph({ repoPath: root });
    assert.deepEqual(graph.adapterBlockers, []);
    assert.ok(!graph.profile.goTestPackages?.["lib/value_windows_test.go"]);
    for (const path of ["_examples/main.go", "lib/testdata/fixture.go", "lib/testdata/new.txt", ".hidden.go"]) {
      assert.equal(new ImpactAnalyzer().analyze(delta(path), graph, graph.profile).fallbackRequired, true);
      const renamed = delta("README.md"); renamed.files[0].oldPath = path; renamed.files[0].changeType = "renamed";
      assert.equal(new ImpactAnalyzer().analyze(renamed, graph, graph.profile).fallbackRequired, true);
    }
    for (const path of ["lib/value.go", "lib/value_windows.go"]) {
      const impact = new ImpactAnalyzer().analyze(delta(path), graph, graph.profile);
      assert.equal(impact.fallbackRequired, false);
      assert.deepEqual(impact.affectedTests.map(t => t.path), ["app/app_test.go", "lib/value_test.go"]);
    }
    const removed = delta("lib/removed.go"); removed.files[0].changeType = "deleted";
    assert.equal(new ImpactAnalyzer().analyze(removed, graph, graph.profile).fallbackRequired, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Go JSON parser rejects partial output and metadata errors", () => {
  assert.throws(() => parseGoList('{"Dir":"/repo","ImportPath":"example"'));
  assert.throws(() => parseGoList("garbage"));
  assert.throws(() => parseGoList("{}"));
  assert.equal(parseGoList('{"Dir":"/repo","ImportPath":"example","Doc":"brace } escaped \\\""}\n').length, 1);
});

test("Go package graph includes internal/external tests, transitive imports, embeds and command routing", async (t) => {
  const root = fixture({ "go.mod": "module example\n\ngo 1.22\n", "lib/lib.go": "package lib", "lib/lib_test.go": "package lib", "app/app.go": "package app", "app/app_test.go": "package app_test", "other/other.go": "package other", "other/other_test.go": "package other" });
  const records = [
    { Dir: join(root, "lib"), ImportPath: "example/lib", GoFiles: ["lib.go"], TestGoFiles: ["lib_test.go"], EmbedFiles: ["message.txt"] },
    { Dir: join(root, "app"), ImportPath: "example/app", GoFiles: ["app.go"], XTestGoFiles: ["app_test.go"], XTestImports: ["example/lib"] },
    { Dir: join(root, "other"), ImportPath: "example/other", GoFiles: ["other.go"], TestGoFiles: ["other_test.go"] },
  ];
  const output = records.map((record) => JSON.stringify(record, null, 2)).join("\n");
  t.mock.method(goAdapter, "analyze", (context: Parameters<typeof analyzeGoMetadata>[0]) => analyzeGoMetadata(context, output));
  try {
    const result = await buildDependencyGraph({ repoPath: root });
    assert.equal(classifyRepositoryProject(root).capable, true);
    assert.deepEqual(result.adapterBlockers, []);
    assert.equal(result.confidence, "COMPLETE");
    for (const path of ["lib/lib.go", "lib/message.txt"]) {
      const impact = new ImpactAnalyzer().analyze(delta(path), result, result.profile);
      assert.equal(impact.fallbackRequired, false, impact.fallbackReasons.join("; "));
      assert.deepEqual(impact.affectedTests.map((test) => test.path).sort(), ["app/app_test.go", "lib/lib_test.go"]);
      const plan = planSelectiveTestCommands(result.profile, impact.affectedTests.map((test) => test.path));
      assert.deepEqual(plan.commands[0].args, ["test", "-mod=readonly", "-json", "-count=1", "./app", "./lib"]);
    }
    assert.equal(new ImpactAnalyzer().analyze(delta("go.mod"), result, result.profile).fallbackRequired, true);
    assert.ok(planSelectiveTestCommands(result.profile, ["unmapped_test.go"]).refusalReason);
    const context = { repoPath: root, files: ["ignored.go"], profile: analyzeRepository({ repoPath: root }) };
    assert.ok(analyzeGoMetadata(context, output).blockers.length);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Go unavailable metadata, workspaces and mixed-language repositories fail closed", async () => {
  const cases: Record<string, string>[] = [
    { "go.mod": "not a module", "main.go": "invalid" },
    { "go.mod": "module example", "go.work": "go 1.22", "main.go": "package main" },
    { "go.mod": "module example", "main.go": "package main", ...jsBase },
  ];
  for (const files of cases) {
    const root = fixture(files);
    try {
      const result = await buildDependencyGraph({ repoPath: root });
      assert.ok(result.adapterBlockers!.length);
      assert.equal(refineConfidenceForDelta(result, ["main.go"]), "UNSAFE");
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("Go test JSON requires complete package outcomes", () => {
  const line = (Action: string, Package = "example/lib", Test?: string) => JSON.stringify({ Action, Package, Test }) + "\n";
  assert.deepEqual(parseGoTestOutput(line("start") + line("pass")), { failures: 0, failedNames: [] });
  assert.deepEqual(parseGoTestOutput(line("start") + line("fail", "example/lib", "TestValue") + line("fail")), { failures: 1, failedNames: ["example/lib/TestValue"] });
  assert.equal(parseGoTestOutput(line("start")), undefined);
  assert.equal(parseGoTestOutput(line("start") + line("pass") + line("start", "example/other")), undefined);
  assert.equal(parseGoTestOutput(line("start") + "invalid json"), undefined);
});

let hasGo = false;
try { execFileSync("go", ["version"], { stdio: "ignore", windowsHide: true }); hasGo = true; } catch { /* explicit skip on hosts without Go */ }
test("explicit Go root scope isolates nested modules but never skips changes there", { skip: !hasGo }, async () => {
  const root = fixture({
    "diffci.json": JSON.stringify({ go: { scope: "root-module" } }),
    "go.mod": "module example\n\ngo 1.22\n",
    "lib.go": "package example\nfunc Value() int { return 1 }\n",
    "lib_test.go": 'package example\nimport "testing"\nfunc TestValue(t *testing.T) { if Value() != 1 { t.Fatal("value") } }\n',
    "nested/go.mod": "module nested\n\ngo 1.22\n",
    "nested/nested.go": "package nested\n",
    "nested/README.md": "nested module",
  });
  try {
    const graph = await buildDependencyGraph({ repoPath: root });
    assert.deepEqual(graph.adapterBlockers, []);
    assert.deepEqual(graph.profile.goExcludedModuleRoots, ["nested/"]);
    assert.equal(new ImpactAnalyzer().analyze(delta("lib.go"), graph, graph.profile).fallbackRequired, false);
    for (const path of ["nested/nested.go", "nested/README.md", "diffci.json"]) assert.equal(new ImpactAnalyzer().analyze(delta(path), graph, graph.profile).fallbackRequired, true);
    const renamed = delta("README.md"); renamed.files[0].oldPath = "nested/README.md"; renamed.files[0].changeType = "renamed";
    assert.equal(new ImpactAnalyzer().analyze(renamed, graph, graph.profile).fallbackRequired, true);
    const command = planSelectiveTestCommands(graph.profile, ["lib_test.go"]).commands[0];
    assert.ok(!command.args.some(arg => arg.includes("nested")));
    execFileSync(command.executable, command.args, { cwd: root, env: { ...process.env, ...command.env }, stdio: "pipe" });
    writeFileSync(join(root, "go.work"), "go 1.22\nuse .\n");
    assert.ok((await buildDependencyGraph({ repoPath: root })).adapterBlockers?.length);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("native Go graph and emitted subset command execute successfully", { skip: !hasGo }, async () => {
  const root = fixture({
    "go.mod": "module example\n\ngo 1.22\n",
    "lib/lib.go": "package lib\nfunc Value() int { return 1 }\n",
    "lib/lib_test.go": 'package lib\nimport "testing"\nfunc TestValue(t *testing.T) { if Value() != 1 { t.Fatal("value") } }\n',
    "other/other.go": "package other\nfunc Other() int { return 2 }\n",
    "other/other_test.go": 'package other\nimport "testing"\nfunc TestOther(t *testing.T) {}\n',
  });
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
    git(["init", "-q"]);
    git(["config", "user.email", "fixture@example.invalid"]);
    git(["config", "user.name", "DiffCI fixture"]);
    git(["add", "."]);
    git(["commit", "-qm", "baseline"]);
    const base = git(["rev-parse", "HEAD"]);
    writeFileSync(join(root, "lib/lib.go"), "package lib\n// Updated documentation\nfunc Value() int { return 1 }\n");
    git(["add", "."]);
    git(["commit", "-qm", "change"]);
    const report = await observe({ repoPath: root, env: {}, version: "test", baseOverride: base, headOverride: "HEAD" });
    assert.equal(report.status, "OBSERVED", report.reason);
    assert.equal(git(["status", "--porcelain"]), "");
    const result = await buildDependencyGraph({ repoPath: root });
    assert.deepEqual(result.adapterBlockers, []);
    const impact = new ImpactAnalyzer().analyze(delta("lib/lib.go"), result, result.profile);
    assert.equal(impact.fallbackRequired, false);
    assert.deepEqual(impact.affectedTests.map((test) => test.path), ["lib/lib_test.go"]);
    const command = planSelectiveTestCommands(result.profile, ["lib/lib_test.go"]).commands[0];
    const full = execFileSync("go", ["test", "-mod=readonly", "-json", "-count=1", "./..."], { cwd: root, encoding: "utf8", env: { ...process.env, ...command.env }, windowsHide: true });
    assert.equal(parseGoTestOutput(full)?.failures, 0);
    const output = execFileSync(command.executable, command.args, { cwd: root, encoding: "utf8", env: { ...process.env, ...command.env }, windowsHide: true });
    assert.equal(parseGoTestOutput(output)?.failures, 0);
    writeFileSync(join(root, "lib/lib.go"), "package lib\nfunc Value() int { return 9 }\n");
    assert.throws(() => execFileSync(command.executable, command.args, { cwd: root, stdio: "pipe", env: { ...process.env, ...command.env }, windowsHide: true }), "selected suite must detect the introduced fault");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
