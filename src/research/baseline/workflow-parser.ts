import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import type { RepositoryProfile } from "../../repo/types.js";

export interface ParsedWorkflowTask {
  id: string;
  name?: string;
  category?: string;
  pathGlobs?: string[];
  pathIgnoreGlobs?: string[];
  dependsOn?: string[];
}

export interface ParsedWorkflow {
  path: string;
  name?: string;
  tasks: ParsedWorkflowTask[];
}

export function parseRepositoryWorkflows(profile: RepositoryProfile, repoPath: string): ParsedWorkflow[] {
  return profile.workflows.map((w) => parseWorkflow(resolve(repoPath, w.path), w.path));
}

function parseWorkflow(absolutePath: string, relativePath: string): ParsedWorkflow {
  let raw: string;
  try {
    raw = readFileSync(absolutePath, "utf8");
  } catch {
    return { path: relativePath, tasks: [] };
  }

  let doc: unknown;
  try {
    doc = YAML.parse(raw) as unknown;
  } catch {
    return { path: relativePath, tasks: [] };
  }

  const name = typeof (doc as Record<string, unknown>).name === "string" ? (doc as Record<string, unknown>).name as string : relativePath;
  const tasks: ParsedWorkflowTask[] = [];
  const jobs = (doc as Record<string, unknown>).jobs as Record<string, unknown> | undefined;
  if (!jobs || typeof jobs !== "object") return { path: relativePath, name, tasks };

  for (const [jobId, jobValue] of Object.entries(jobs)) {
    if (!jobValue || typeof jobValue !== "object") continue;
    const job = jobValue as Record<string, unknown>;
    const namePart = typeof job.name === "string" ? job.name : jobId;
    const paths = normalizeStringArray(job["paths"]) ?? normalizeStringArray((job.on as Record<string, unknown>)?.paths) ?? [];
    const pathsIgnore = normalizeStringArray(job["paths-ignore"]) ?? [];
    const dependsOn = normalizeStringArray(job.needs) ?? [];
    const stepNames: string[] = [];
    const steps = Array.isArray(job.steps) ? (job.steps as Record<string, unknown>[]) : [];
    for (const step of steps) {
      if (typeof step?.name === "string") stepNames.push(step.name as string);
    }

    const category = inferCategory(namePart + " " + stepNames.join(" "));
    tasks.push({
      id: `${relativePath.replace(/.ya?ml$/, "")}::${jobId}`,
      name: namePart,
      category,
      pathGlobs: paths.length > 0 ? paths : undefined,
      pathIgnoreGlobs: pathsIgnore.length > 0 ? pathsIgnore : undefined,
      dependsOn,
    });
  }

  return { path: relativePath, name, tasks };
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string") return [value];
  return undefined;
}

function inferCategory(text: string): string {
  const lower = text.toLowerCase();
  if (lower.includes("typecheck") || lower.includes("typescript") || lower.includes("tsc")) return "typecheck";
  if (lower.includes("lint")) return "lint";
  if (lower.includes("security") || lower.includes("audit") || lower.includes("snyk")) return "security";
  if (lower.includes("build")) return "build";
  if (lower.includes("e2e") || lower.includes("playwright") || lower.includes("cypress")) return "e2e";
  if (lower.includes("integration")) return "integration";
  if (lower.includes("unit") || lower.includes("test")) return "test";
  if (lower.includes("deploy")) return "deploy";
  if (lower.includes("infra") || lower.includes("terraform")) return "infrastructure";
  return "validation";
}
