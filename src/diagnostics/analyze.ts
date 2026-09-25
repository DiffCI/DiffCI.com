import { readBoundedText } from "../hosted/limits.js";

export function parsePublicRepository(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let value = input.trim();
  if (value.startsWith("https://github.com/")) {
    try {
      const url = new URL(value);
      if (url.host !== "github.com" || url.username || url.password || url.search || url.hash) return null;
      value = url.pathname.replace(/^\//, "").replace(/\/$/, "");
    } catch { return null; }
  }
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/.test(value)) return null;
  if ([".", ".."].includes(value.split("/")[1]!)) return null;
  return value;
}

export interface CompatibilityReport {
  schema: "diffci.compatibility.v1";
  repository: string;
  headSha: string;
  checkedAt: string;
  evidence: "public_root_metadata_only";
  status: "candidate" | "needs_local_diagnosis";
  detected: string[];
  findings: string[];
  filesInspected: string[];
  unknowns: string[];
  nextCommand: string;
}

/** No auth token, clone, shell, dependency installation, XML evaluation or repository code execution.
 * At most six requests, each capped at 128 KiB, under one 20-second deadline. */
export async function analyzePublicRepository(repository: string, fetchImpl: typeof fetch = fetch): Promise<CompatibilityReport> {
  if (parsePublicRepository(repository) !== repository) throw new Error("invalid_repository");
  const signal = AbortSignal.timeout(20000);
  const base = `https://api.github.com/repos/${repository.split("/").map(encodeURIComponent).join("/")}`;
  async function get(path: string): Promise<unknown> {
    const response = await fetchImpl(`${base}${path}`, { redirect: "error", signal,
      headers: { Accept: "application/vnd.github+json", "User-Agent": "DiffCI-public-diagnostic" } });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(response.status === 404 ? "repository_unavailable" : response.status === 403 || response.status === 429 ? "upstream_rate_limited" : "upstream_unavailable");
    }
    return JSON.parse(await readBoundedText(response, 128 * 1024));
  }
  const metadata = await get("") as { private?: boolean; visibility?: string; default_branch?: string; archived?: boolean };
  if (metadata.private !== false || (metadata.visibility && metadata.visibility !== "public") || typeof metadata.default_branch !== "string") throw new Error("repository_unavailable");
  const commit = await get(`/commits/${encodeURIComponent(metadata.default_branch)}`) as { sha?: string };
  if (!commit.sha || !/^[a-f0-9]{40}$/.test(commit.sha)) throw new Error("invalid_upstream_response");
  const entries = await get(`/contents?ref=${commit.sha}`) as Array<{ name?: string; type?: string }>;
  if (!Array.isArray(entries) || entries.length > 1000) throw new Error("repository_too_large");
  const files = new Set(entries.filter((entry) => entry.type === "file" && typeof entry.name === "string").map((entry) => entry.name!));
  const detected: string[] = [];
  const findings: string[] = [];
  const filesInspected: string[] = [];
  if (metadata.archived) findings.push("Repository is archived; active CI and maintainer activity were not verified.");
  async function readManifest(name: string): Promise<string> {
    const entry = await get(`/contents/${name}?ref=${commit.sha}`) as { type?: string; encoding?: string; content?: string; size?: number };
    if (entry.type !== "file" || entry.encoding !== "base64" || typeof entry.content !== "string" || !Number.isFinite(entry.size) || entry.size! > 65536) throw new Error("manifest_unavailable");
    const binary = atob(entry.content.replace(/\s/g, ""));
    if (binary.length > 65536) throw new Error("manifest_too_large");
    filesInspected.push(name);
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  }
  if (files.has("package.json")) {
    const pkg = JSON.parse(await readManifest("package.json")) as Record<string, unknown>;
    detected.push("JavaScript / TypeScript manifest");
    if (pkg.workspaces) findings.push("Workspace configuration detected; package-level command and dependency coverage need local verification.");
    if (!files.has("tsconfig.json")) findings.push("No root tsconfig.json listed; confirm the applicable project scope locally.");
    const scripts = pkg.scripts as Record<string, unknown> | undefined;
    if (!scripts || typeof scripts.test !== "string") findings.push("No root test script found; command inference needs local diagnosis.");
    // Report only known runner labels, never echo or execute untrusted manifest commands.
    const test = typeof scripts?.test === "string" ? scripts.test : "";
    const runner = ["vitest", "jest", "mocha", "tap", "ava"].find((name) => new RegExp(`\\b${name}\\b`).test(test));
    if (runner) detected.push(`${runner} mentioned in test script (not execution-verified)`);
  }
  if (files.has("go.mod")) {
    await readManifest("go.mod"); detected.push("Go module");
    findings.push("Go analysis needs a local toolchain and prepared dependencies; package selection is not validated here.");
  }
  if (files.has("pom.xml")) {
    await readManifest("pom.xml"); detected.push("Maven manifest");
    findings.push("Maven selection requires a validated CI goal and profiles; reactor compatibility is unknown.");
  }
  if (!detected.length) findings.push("No supported root manifest found. Nested projects and other languages require local diagnosis.");
  return { schema: "diffci.compatibility.v1", repository, headSha: commit.sha, checkedAt: new Date().toISOString(),
    evidence: "public_root_metadata_only", status: findings.length ? "needs_local_diagnosis" : "candidate", detected, findings, filesInspected,
    unknowns: ["Dependency graph and test selection were not computed.", "CI compatibility, failure preservation and runtime savings are unmeasured.", "No repository code or tests were executed; private repositories are unsupported."],
    nextCommand: 'npx "@diffci.com/diffci@latest" observe --no-send' };
}
