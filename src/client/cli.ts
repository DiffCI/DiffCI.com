/**
 * `diffci` - the client-side command (Phase 02, 2026-08-26).
 *
 * This is the binary a third-party repository runs in its own CI. Everything it does is observation:
 * it reads a checkout, writes one JSON report to a path outside that checkout, prints a summary,
 * optionally sends that report to DiffCI, and exits 0. There is no mode in this file that runs, skips,
 * cancels or re-orders anything, and the absence is deliberate - the seven-day Phase 02 criterion is
 * "CI byte-identical", and a flag that could change what CI runs is a flag that will eventually be set
 * by accident.
 *
 * Sending is opt-in and off unless both an API URL and a token are supplied (Phase 03). Without them
 * the observer is exactly what Phase 02 shipped: a local analysis whose output never leaves the runner.
 *
 * Commands:
 *   observe            analyse the checkout and write an observation report
 *   verify-workflow    check that a DiffCI job in this repository's workflows cannot affect other jobs
 *   version            print the observer version
 *
 * Exit codes: `observe` exits 0 even when it refuses or errors, because a broken observer must not
 * fail somebody's build; the status is in the report and in the printed summary. `--fail-on-error`
 * opts out of that, for operators running it deliberately. The one exception is exit 2, for a
 * misconfigured invocation that would itself break the byte-identical guarantee (a report path inside
 * the observed checkout) - nothing was observed, and the caller has to change the call. `verify-workflow`
 * exits 1 on a BLOCKING finding - it is a pre-install check run by a human, not a step inside a build.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { observe, isInsideRepository } from "./observe.js";
import type { ObservationReport, WorkflowFinding } from "./report.js";
import { submitObservation } from "./submit.js";
import { auditWorkflows, isNonInterfering } from "./workflow-guard.js";

interface ParsedArgs {
  command?: string;
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const args = argv.slice(2);
  const flags: Record<string, string | boolean> = {};
  let command: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (!token.startsWith("--")) {
      command ??= token;
      continue;
    }
    const key = token.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { command, flags };
}

/**
 * The observer's own version and commit. Found by walking up from this file rather than by a fixed
 * relative path, because this module runs both from source (tsx, depth src/client) and from compiled
 * output (node, depth dist-client/src/client) and a hardcoded `../..` is right in exactly one of them.
 */
function observerIdentity(): { version: string; root?: string; sha?: string } {
  let current = dirname(import.meta.filename);
  for (let depth = 0; depth < 8; depth++) {
    const candidate = join(current, "package.json");
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string; version?: string };
        // Installed agents have their own name. Never attribute the customer's
        // surrounding git checkout to the engine when reading this manifest.
        if (parsed.name === "@diffci/observer") return { version: parsed.version ?? "0.0.0", root: current };
        if (parsed.name === "diffci") {
          let sha: string | undefined;
          try {
            sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: current, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
          } catch {
            // Installed from a tarball rather than a checkout: there is no commit to report, and
            // inventing one would be worse than the field being absent.
          }
          return { version: parsed.version ?? "0.0.0", root: current, sha };
        }
      } catch {
        // Keep walking - an unreadable package.json above us says nothing about ours.
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { version: "0.0.0" };
}

function defaultReportPath(env: NodeJS.ProcessEnv): string {
  // RUNNER_TEMP is outside GITHUB_WORKSPACE on every GitHub-hosted runner, which is the property that
  // matters: the report cannot become an untracked file in the repository being observed.
  const base = env.RUNNER_TEMP && existsSync(env.RUNNER_TEMP) ? env.RUNNER_TEMP : tmpdir();
  const stamp = env.GITHUB_RUN_ID ? `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT ?? "1"}` : String(Date.now());
  return join(base, `diffci-observation-${stamp}.json`);
}

function formatFinding(finding: WorkflowFinding): string {
  const where = finding.job ? `${finding.workflow}#${finding.job}` : finding.workflow;
  return `  [${finding.severity}] ${finding.code} (${where})\n      ${finding.message}`;
}

function summarise(report: ObservationReport): string {
  const lines: string[] = [];
  lines.push(`DiffCI observation: ${report.status} (${report.stage})`);
  if (report.reason) lines.push(`  reason: ${report.reason}`);
  if (report.commitRange) {
    lines.push(
      `  range: ${report.commitRange.baseSha.slice(0, 12)}..${report.commitRange.headSha.slice(0, 12)} (${report.commitRange.source})`,
    );
  }
  const result = report.result;
  if (result) {
    lines.push(`  verdict: ${result.mode}`);
    if (result.goScope) lines.push("  Go scope: root module only; nested-module CI remains separate");
    if (result.vueScope) lines.push(`  Vue suite: ${result.vueScope.packageRoot} (${result.vueScope.testConfig})`);
    lines.push(
      `  selection: ${result.selectedTests.length}/${result.totalTestCount} test files, from ${result.changedFileCount} changed file(s)`,
    );
    lines.push(
      `  comparator: a simple path-rule CI would have run ${result.pathBaseline.mode === "FULL" ? "everything" : `${result.pathBaseline.selectedTestCount} test file(s)`}`,
    );
    lines.push(`  graph: ${result.graph.nodes} nodes, confidence ${result.graph.effectiveConfidence ?? result.graph.confidence}`);
    if (result.fallbackReasons.length > 0) {
      lines.push(`  fallback: ${result.fallbackReasons.join("; ")}`);
    }
    for (const command of result.proposedCommands) lines.push(`  would have run: ${command}`);
    if (result.commandRefusalReason) lines.push(`  no command: ${result.commandRefusalReason}`);
    if (result.blindSpot) {
      lines.push("  blind spot: this repository declares a test framework and DiffCI discovered none of its tests");
    }
  }
  lines.push(
    `  non-interference: worktree ${report.nonInterference.worktreeUnchanged ? "unchanged" : "CHANGED - report this"}, report written ${report.nonInterference.reportWrittenOutsideRepository ? "outside" : "INSIDE"} the checkout`,
  );
  const blocking = report.nonInterference.workflowFindings.filter((f) => f.severity === "BLOCKING");
  if (blocking.length > 0) {
    lines.push(`  workflow: ${blocking.length} blocking finding(s) - this installation CAN affect other jobs:`);
    for (const finding of blocking) lines.push(formatFinding(finding));
  }
  lines.push("  DiffCI changed nothing: no test was run, skipped, cancelled or re-ordered by this step.");
  return lines.join("\n");
}

async function runObserve(flags: Record<string, string | boolean>, env: NodeJS.ProcessEnv): Promise<number> {
  const repoPath = resolve(typeof flags.repo === "string" ? flags.repo : env.GITHUB_WORKSPACE ?? process.cwd());
  const reportPath = resolve(typeof flags.out === "string" ? flags.out : defaultReportPath(env));

  if (isInsideRepository(repoPath, reportPath) && flags["allow-in-tree-report"] !== true) {
    // Refused rather than relocated: a caller who asked for a path inside the checkout may have a
    // reason, and silently writing somewhere else would make the artifact they collect disappear.
    console.error(
      `Refusing to write the report to ${reportPath}: it is inside the repository being observed, where an untracked file changes \`git status\` and can fail a clean-tree check. Pass --out with a path outside the checkout (RUNNER_TEMP is the default), or --allow-in-tree-report to accept that risk.`,
    );
    return 2;
  }

  const identity = observerIdentity();
  let economicsHistory: unknown;
  if (typeof flags["economics-history"] === "string") {
    try { economicsHistory = JSON.parse(readFileSync(resolve(flags["economics-history"]), "utf8")); }
    catch { console.warn("DiffCI timing history is unreadable; performing normal analysis."); }
  }
  const report = await observe({
    repoPath,
    env: env as Record<string, string | undefined>,
    version: identity.version,
    engineSha: identity.sha,
    baseOverride: typeof flags.base === "string" ? flags.base : undefined,
    headOverride: typeof flags.head === "string" ? flags.head : undefined,
    redactPaths: flags["redact-paths"] === true,
    reportPath,
    economicsHistory,
    economicsJobKey: typeof flags["economics-job"] === "string" ? flags["economics-job"] : undefined,
    forceAnalysis: flags["force-analysis"] === true,
  });

  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const summary = summarise(report);
  if (flags.json === true) {
    console.log(JSON.stringify(report, null, 2));
  } else if (flags.quiet !== true) {
    console.log(summary);
    console.log(`  report: ${reportPath}`);
  }

  // Sending happens before the job summary is written, so the summary can say whether it worked.
  // It is allowed to fail: by this point the report is on disk and (in the action) about to become an
  // artifact, so a delivery problem costs the observation nothing - it is DiffCI's problem to fix, not
  // the host repository's build to fail. By this point the report is on
  // disk and (in the action) about to become an artifact, so a delivery problem costs the observation
  // nothing - it is DiffCI's problem to fix, not the host repository's build to fail.
  const apiUrl = typeof flags["api-url"] === "string" ? flags["api-url"] : env.DIFFCI_API_URL;
  const apiToken = typeof flags["api-token"] === "string" ? flags["api-token"] : env.DIFFCI_TOKEN;
  let delivery: string | undefined;
  if (apiUrl && apiToken && flags["no-send"] !== true) {
    const outcome = await submitObservation({ apiUrl, token: apiToken, report });
    delivery = outcome.ok
      ? `sent${outcome.duplicate ? " (already recorded - a re-run or retry of the same observation)" : ""}`
      : `not sent (${outcome.kind}): ${outcome.message}`;
    if (flags.quiet !== true) console.log(`  delivery: ${delivery}`);
  } else if (apiUrl && !apiToken && flags["no-send"] !== true) {
    delivery = "not sent: an api-url was given with no api-token";
    if (flags.quiet !== true) console.log(`  delivery: ${delivery}`);
  }

  // GitHub renders this under the job. It is the only place most people will ever read a report, so it
  // says the same thing the report says, including when the answer is "refused" or "not sent".
  if (env.GITHUB_STEP_SUMMARY) {
    try {
      writeFileSync(
        env.GITHUB_STEP_SUMMARY,
        `### DiffCI (observation only)\n\n\`\`\`\n${summary}${delivery ? `\n  delivery: ${delivery}` : ""}\n\`\`\`\n`,
        { flag: "a" },
      );
    } catch {
      // Losing the summary is cosmetic; the report on disk is the record.
    }
  }

  if (env.GITHUB_OUTPUT) {
    try {
      writeFileSync(env.GITHUB_OUTPUT, `report-path=${reportPath}\nstatus=${report.status}\n`, { flag: "a" });
    } catch {
      // Same: the outputs are a convenience for the workflow, not the record.
    }
  }

  if (flags["fail-on-error"] === true && report.status !== "OBSERVED") return 1;
  return 0;
}

function runVerifyWorkflow(flags: Record<string, string | boolean>, env: NodeJS.ProcessEnv): number {
  const repoPath = resolve(typeof flags.repo === "string" ? flags.repo : env.GITHUB_WORKSPACE ?? process.cwd());
  const result = auditWorkflows(repoPath);

  if (result.workflowsScanned.length === 0) {
    console.log(`No workflow files found under ${join(repoPath, ".github", "workflows")}. Nothing was checked.`);
    return 1;
  }
  console.log(`Scanned ${result.workflowsScanned.length} workflow file(s).`);
  if (result.observerJobs.length === 0) {
    console.log("No job runs the DiffCI action. Add one before starting the observation window.");
    return 1;
  }
  console.log(`DiffCI runs in: ${result.observerJobs.join(", ")}`);

  if (result.findings.length === 0) {
    console.log("No findings: nothing in these workflows lets the observation change what the rest of CI does.");
    return 0;
  }
  for (const finding of result.findings) console.log(formatFinding(finding));
  if (isNonInterfering(result)) {
    console.log("\nNo blocking findings. The observation cannot change what the rest of CI does.");
    return 0;
  }
  console.log("\nBlocking findings above: as written, this installation CAN change what the rest of CI does.");
  return 1;
}

const USAGE = `diffci - observation-only change-aware CI analysis

Usage:
  diffci observe [--repo <path>] [--out <file>] [--base <sha> --head <sha>]
                 [--redact-paths] [--json] [--quiet] [--fail-on-error]
                 [--api-url <url> --api-token <token>] [--no-send]
  diffci verify-workflow [--repo <path>]
  diffci version

observe analyses the checkout and writes one JSON report. It runs nothing and changes nothing.
verify-workflow checks that the job running DiffCI cannot affect any other job, and exits 1 if it can.

The report is sent only when both --api-url and --api-token are given (or DIFFCI_API_URL and
DIFFCI_TOKEN are set). A failed send is reported and never fails the step - the report is on disk
either way. Plain http is refused; the token is never printed.
`;

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv);
  const env = process.env;

  if (flags.help === true || command === "help" || command === undefined) {
    console.log(USAGE);
    process.exitCode = command === undefined ? 1 : 0;
    return;
  }

  switch (command) {
    case "observe":
      process.exitCode = await runObserve(flags, env);
      return;
    case "verify-workflow":
      process.exitCode = runVerifyWorkflow(flags, env);
      return;
    case "version":
      console.log(observerIdentity().version);
      return;
    default:
      console.error(`Unknown command "${command}".\n\n${USAGE}`);
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  // Reaching here means a defect outside observe()'s own guard. It still must not take a build down:
  // the failure is printed, and the exit code stays 0 unless the caller asked otherwise.
  console.error(`DiffCI observer failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = process.argv.includes("--fail-on-error") ? 1 : 0;
});
