#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = process.cwd();
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const node = process.execPath;

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...(options.env ?? {}) },
    shell: options.shell ?? false,
  });
}

function runNpm(args, options = {}) {
  if (process.platform !== "win32") return run(npm, args, options);
  const command = [npm, ...args].map(quoteWindowsArg).join(" ");
  return run("cmd.exe", ["/d", "/c", command], options);
}

function quoteWindowsArg(value) {
  const text = String(value);
  return /[\s"&|<>^]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function write(file, contents) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents, "utf8");
}

function git(repoPath, args) {
  return run("git", args, { cwd: repoPath });
}

function createFixtureRepo(parent) {
  const repoPath = join(parent, "fixture-repo");
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "--quiet"]);
  git(repoPath, ["config", "user.email", "test@diffci.local"]);
  git(repoPath, ["config", "user.name", "DiffCI Package Smoke"]);
  git(repoPath, ["config", "core.autocrlf", "false"]);

  write(
    join(repoPath, "package.json"),
    `${JSON.stringify({ name: "fixture", version: "1.0.0", devDependencies: { vitest: "^1.0.0" }, scripts: { test: "vitest run" } }, null, 2)}\n`,
  );
  write(
    join(repoPath, "tsconfig.json"),
    // The runner still discovers tests when the compiler only includes implementation files.
    // This fixture must exercise their dependency edges in the actual installed tarball.
    `${JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", strict: true }, include: ["src"] }, null, 2)}\n`,
  );
  write(join(repoPath, "src", "alpha.ts"), "export const alpha = () => 1;\n");
  write(join(repoPath, "src", "beta.ts"), "export const beta = () => 2;\n");
  write(join(repoPath, "test", "alpha.test.ts"), "import { alpha } from '../src/alpha.js';\nexport const check = () => alpha();\n");
  write(join(repoPath, "test", "beta.test.ts"), "import { beta } from '../src/beta.js';\nexport const check = () => beta();\n");
  git(repoPath, ["add", "-A"]);
  git(repoPath, ["commit", "--quiet", "-m", "initial"]);

  const base = git(repoPath, ["rev-parse", "HEAD"]).trim();
  write(join(repoPath, "src", "alpha.ts"), "export const alpha = () => 42;\n");
  git(repoPath, ["add", "-A"]);
  git(repoPath, ["commit", "--quiet", "-m", "change alpha"]);
  const head = git(repoPath, ["rev-parse", "HEAD"]).trim();

  return { repoPath, base, head };
}

function createMavenFixtureRepo(parent) {
  const repoPath = join(parent, "maven-fixture");
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "--quiet"]);
  git(repoPath, ["config", "user.email", "test@diffci.local"]);
  git(repoPath, ["config", "user.name", "DiffCI Package Smoke"]);
  git(repoPath, ["config", "core.autocrlf", "false"]);
  write(join(repoPath, "diffci.json"), JSON.stringify({ maven: { goal: "verify", profiles: ["run-its"] } }));
  write(join(repoPath, "pom.xml"), "<project><groupId>example</groupId><artifactId>parent</artifactId><version>1</version><modules><module>tools</module></modules></project>\n");
  write(join(repoPath, "tools", "pom.xml"), "<project><artifactId>tools</artifactId></project>\n");
  write(join(repoPath, "tools", "src", "main", "java", "example", "Tool.java"), "package example; public class Tool { public int value() { return 1; } }\n");
  write(join(repoPath, "tools", "src", "test", "java", "example", "ToolTest.java"), "package example; public class ToolTest {}\n");
  git(repoPath, ["add", "-A"]);
  git(repoPath, ["commit", "--quiet", "-m", "initial"]);
  const base = git(repoPath, ["rev-parse", "HEAD"]).trim();
  write(join(repoPath, "tools", "src", "main", "java", "example", "Tool.java"), "package example; public class Tool { public int value() { return 2; } }\n");
  git(repoPath, ["add", "-A"]);
  git(repoPath, ["commit", "--quiet", "-m", "change tool"]);
  return { repoPath, base, head: git(repoPath, ["rev-parse", "HEAD"]).trim() };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const temp = mkdtempSync(join(tmpdir(), "diffci-package-smoke-"));
try {
  runNpm(["run", "build:client"], { stdio: "inherit" });
  run(node, ["scripts/check-oss-boundary.mjs"], { stdio: "inherit" });
  const packJson = runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", temp]);
  const pack = JSON.parse(packJson)[0];
  const packedPaths = new Set(pack.files.map((file) => file.path));
  assert(packedPaths.has("node_modules/@diffci.com/core/dist/index.js"), "Core engine must be bundled into the CLI tarball");
  assert(packedPaths.has("node_modules/@diffci.com/core/dist/repo/adapters/maven.js"), "Maven adapter must be bundled into the CLI tarball");
  assert(![...packedPaths].some((path) => path.startsWith("dist-client/src/repo/") || path.startsWith("dist-client/src/git/") || path.startsWith("dist-client/src/planner/")), "CLI tarball must not duplicate Core engine modules");
  const tarball = join(temp, pack.filename);
  assert(existsSync(tarball), `npm pack did not create ${tarball}`);

  const consumer = join(temp, "consumer");
  mkdirSync(consumer);
  runNpm(["init", "-y"], { cwd: consumer, stdio: "ignore" });
  runNpm(["install", "--ignore-scripts", "--no-audit", "--fund=false", tarball], { cwd: consumer, stdio: "inherit" });

  const { repoPath, base, head } = createFixtureRepo(temp);
  const reportPath = join(temp, "report.json");
  const bin = join(consumer, "node_modules", ".bin", process.platform === "win32" ? "diffci.cmd" : "diffci");
  const mcpBin = join(consumer, "node_modules", ".bin", process.platform === "win32" ? "diffci-mcp.cmd" : "diffci-mcp");
  assert(existsSync(bin), `installed package did not create ${bin}`);
  assert(existsSync(mcpBin), `installed package did not create ${mcpBin}`);
  const installedVersion = runNpm(["exec", "--", "diffci", "version"], { cwd: consumer }).trim();
  assert(installedVersion === pack.version, `expected diffci version ${pack.version}, got ${installedVersion}`);
  runNpm(["exec", "--", "diffci", "observe", "--repo", repoPath, "--base", base, "--head", head, "--out", reportPath, "--json", "--no-send"], {
    cwd: consumer,
  });

  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  assert(report.status === "OBSERVED", `expected OBSERVED, got ${report.status}: ${report.reason ?? ""}`);
  assert(report.result?.mode === "SELECTIVE", `expected SELECTIVE, got ${report.result?.mode}`);
  assert(
    JSON.stringify(report.result.selectedTests) === JSON.stringify(["test/alpha.test.ts"]),
    `unexpected selected tests: ${JSON.stringify(report.result?.selectedTests)}`,
  );
  assert(report.nonInterference?.worktreeUnchanged === true, "packaged CLI changed the observed checkout");

  const maven = createMavenFixtureRepo(temp);
  const mavenReportPath = join(temp, "maven-report.json");
  runNpm(["exec", "--", "diffci", "observe", "--repo", maven.repoPath, "--base", maven.base, "--head", maven.head, "--out", mavenReportPath, "--json", "--no-send"], { cwd: consumer });
  const mavenReport = JSON.parse(readFileSync(mavenReportPath, "utf8"));
  assert(mavenReport.status === "OBSERVED" && mavenReport.result?.mode === "SELECTIVE", `packaged Maven observation failed: ${mavenReport.reason ?? mavenReport.result?.fallbackReasons?.join("; ") ?? mavenReport.status}`);
  assert(mavenReport.result.proposedCommands?.includes("mvn -pl tools -am verify -P run-its"), `unexpected Maven command: ${JSON.stringify(mavenReport.result.proposedCommands)}`);
  assert(mavenReport.nonInterference?.worktreeUnchanged === true, "packaged CLI changed the Maven checkout");

  console.log(`Package smoke passed: ${pack.filename} installed and ran JavaScript and Maven observations.`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
