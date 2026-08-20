import { execSync } from "node:child_process";
import { analyzeGitDelta, gitDeltaToJson } from "../src/git/git-diff.js";

const root = process.cwd();
const head = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
const base = execSync("git rev-parse HEAD~1", { encoding: "utf8" }).trim();

const result = await analyzeGitDelta({ repoPath: root, baseSha: base, headSha: head });

if (!result.success) {
  console.error(result.error);
  process.exit(1);
}

console.log(gitDeltaToJson(result.delta));
