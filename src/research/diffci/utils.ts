import { readFileSync } from "node:fs";

export async function readFileContents(repoPath: string, path: string): Promise<string | undefined> {
  try {
    return readFileSync(`${repoPath}/${path}`, "utf8");
  } catch {
    return undefined;
  }
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}
