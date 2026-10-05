/** Fresh-process, alternating-order comparison of graph program construction, not CI savings. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import ts from "typescript";
import { analyzeRepository } from "../src/repo/analyzer.js";
import { createGraphCompilerHost } from "./lib/typescript-host-candidate.js";

interface Sample {
  run: number; variant: string; programMs: number; sourceFiles: number; implementationFiles: number;
  sourcePathsSha256: string; implementationSha256: string; referenceDirectivesSha256: string;
}

if (process.argv[2] === "--sample") {
  const repoPath = resolve(process.argv[3]); const variant = process.argv[4];
  const configPath = join(repoPath, "tsconfig.json");
  const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
  if (loaded.error) throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, dirname(configPath), undefined, configPath);
  if (parsed.projectReferences?.length) throw new Error("Benchmark requires a single root project; merged reference projects need a separate cohort");
  const profile = analyzeRepository({ repoPath, excludeDirs: ["node_modules", ".next", "dist", "build"] });
  const testSources = profile.testFilePaths.filter((file) => /\.[cm]?[jt]sx?$/.test(file)).map((file) => join(repoPath, file));
  const rootNames = [...new Set([...parsed.fileNames, ...testSources])];
  const options = testSources.length ? { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022, ...parsed.options, allowJs: true } : parsed.options;
  const started = performance.now();
  const program = ts.createProgram({ rootNames, options, ...(variant === "optimized" ? { host: createGraphCompilerHost(options) } : {}) });
  const files = program.getSourceFiles(); const programMs = performance.now() - started;
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  console.log(JSON.stringify({ variant, programMs, sourceFiles: files.length,
    implementationFiles: files.filter((file) => !file.isDeclarationFile).length,
    sourcePathsSha256: hash(files.map((file) => file.fileName).sort()),
    implementationSha256: hash(files.filter((file) => !file.isDeclarationFile).map((file) => [file.fileName, file.text]).sort()),
    referenceDirectivesSha256: hash(files.map((file) => [file.fileName, file.referencedFiles, file.typeReferenceDirectives, file.libReferenceDirectives, file.hasNoDefaultLib]).sort()) }));
} else {
  const args = process.argv.slice(2); const outputIndex = args.indexOf("--out");
  if (outputIndex < 1 || outputIndex !== args.length - 2) throw new Error("Usage: tsx scripts/benchmark-typescript-host.ts <repository> [...] --out <external-summary.json>");
  const results = [];
  for (const repository of args.slice(0, outputIndex)) {
    const samples: Sample[] = [];
    for (let run = 0; run < 3; run++) {
      for (const variant of run % 2 ? ["optimized", "baseline"] : ["baseline", "optimized"]) {
        const sample = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", import.meta.filename, "--sample", repository, variant],
          { encoding: "utf8", timeout: 120_000, maxBuffer: 1_000_000 }));
        samples.push({ run: run + 1, ...sample });
        console.log(`${repository} ${variant} run ${run + 1}: ${sample.programMs.toFixed(1)}ms`);
      }
    }
    for (const key of ["sourcePathsSha256", "implementationSha256", "referenceDirectivesSha256"] as const)
      if (new Set(samples.map((sample) => sample[key])).size !== 1) throw new Error(`Program inputs changed or diverged: ${repository} ${key}`);
    const median = (variant: string) => samples.filter((sample) => sample.variant === variant).map((sample) => sample.programMs).sort((a, b) => a - b)[1];
    const baselineMedianMs = median("baseline"); const optimizedMedianMs = median("optimized");
    results.push({ repository: resolve(repository), baselineMedianMs, optimizedMedianMs,
      medianProgramReduction: 1 - optimizedMedianMs / baselineMedianMs, samples });
  }
  writeFileSync(resolve(args[outputIndex + 1]), JSON.stringify({ schema: "diffci.typescript-host-benchmark.v1", collectedAt: new Date().toISOString(),
    node: process.version, typescript: ts.version, platform: process.platform, results,
    evidenceLimit: "Local program-construction timings, three samples per arm in fresh processes with alternating order. OS caches uncontrolled. No end-to-end CI, safety recall or realized savings claim." }, null, 2) + "\n");
}
