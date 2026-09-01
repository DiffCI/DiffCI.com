import { readFileSync, writeFileSync } from "node:fs";

const p = "scripts/ci-inference-benchmark.ts";
const lines = readFileSync(p, "utf8").split(/\r?\n/);
const start = lines.findIndex((l) => l.startsWith("function score("));
let end = start;
while (!/^\}/.test(lines[end])) end++;

const body = `/**
 * Scores an inference against a known failure, WITHOUT telling the engine what the failure was.
 *
 * INFERENCE_02 adds the boundary that matters: an operation may be REPORTABLE and not EXECUTABLE. The
 * engine is allowed to say what it believes a command probably is; a decision engine is not allowed to
 * act on that belief. So the first question asked of every row is whether the pipeline is optimisable
 * at all — and refusing is a SUCCESS, not a gap.
 *
 * THE BAR FOR A WIN IS AVOIDANCE, NOT DIFFERENCE. INFERENCE_01 scored a win whenever the inferred
 * command differed from the generic one, which handed \`eslint-plugin-vue\` a pass for \`npm install\`
 * against \`npm install --no-audit --no-fund\` — flags that cannot affect an arborist crash.
 */
function score(
  row: { knownFailure: { stage: string; detail: string } },
  inferred: InferredPipeline,
  generic: { install: string[] },
): { verdict: BenchmarkVerdict; reason: string } {
  const install = inferred.operations.find((o) => o.kind === "install");

  // A resource-limit failure is a different learning problem from configuration inference, and is kept
  // separate rather than scored as if evidence could have predicted it.
  if (row.knownFailure.stage === "build" && /heap out of memory|OOM/i.test(row.knownFailure.detail)) {
    return {
      verdict: "INSUFFICIENT_EVIDENCE",
      reason: \`configuration inference cannot predict a runner resource limit; \${inferred.optimisable ? "the pipeline was judged optimisable" : "optimisation was refused: " + inferred.optimisationRefusal}\`,
    };
  }

  // THE HARD BOUNDARY, checked before anything else.
  if (!inferred.optimisable) {
    return {
      verdict: "CORRECT_REFUSAL",
      reason: \`refused to optimise - \${inferred.optimisationRefusal}\`,
    };
  }

  if (row.knownFailure.stage === "install") {
    if (!install || install.command.length === 0) {
      return { verdict: "INSUFFICIENT_EVIDENCE", reason: "no install operation could be inferred" };
    }
    const inferredCmd = install.command.join(" ");
    const genericCmd = generic.install.join(" ");
    const resolutionFlags = /--legacy-peer-deps|--force|--frozen-lockfile|--immutable/;
    const addsResolutionFlag = resolutionFlags.test(inferredCmd) && !resolutionFlags.test(genericCmd);
    const differentManager = install.command[0] !== generic.install[0] || install.command[1] !== generic.install[1];
    if (addsResolutionFlag || differentManager) {
      return {
        verdict: "CORRECT_INFERENCE",
        reason: \`executable install \\\`\${inferredCmd}\\\` (\${install.confidence}) - materially different from the generic \\\`\${genericCmd}\\\` in a way that addresses the recorded failure\`,
      };
    }
    return {
      verdict: "INCORRECT_INFERENCE",
      reason: \`judged the pipeline optimisable and proposed \\\`\${inferredCmd}\\\`, which differs from the failing generic command only in flags that cannot affect it\`,
    };
  }

  const executable = inferred.operations.filter((o) => o.executable && o.kind !== "checkout" && o.kind !== "install");
  if (executable.length === 0) {
    return { verdict: "INSUFFICIENT_EVIDENCE", reason: "no executable operation could be inferred from workflow evidence" };
  }
  return {
    verdict: "INSUFFICIENT_EVIDENCE",
    reason: \`judged optimisable and proposes the repository's own \\\`\${executable.map((o) => o.command.join(" ")).join(" && ")}\\\`, but whether that avoids a genuine test failure cannot be decided without executing it\`,
  };
}`;

lines.splice(start, end - start + 1, ...body.split("\n"));
let out = lines.join("\n");

// Report the boundary alongside each row.
out = out.replace(
  "    console.log(`      facts ${String(facts.length).padStart(4)}   operations ${String(inferred.operations.length).padStart(2)}   unresolved ${inferred.unresolved.length}`);",
  "    console.log(`      facts ${String(facts.length).padStart(4)}   operations ${String(inferred.operations.length).padStart(2)}   refs ${String(inferred.references.length).padStart(3)}   optimisable ${inferred.optimisable ? \"YES\" : \"NO\"}`);",
);

writeFileSync(p, out);
console.log("benchmark scoring updated for the executability boundary");
