import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { summarizeDentalPresencePairs } from "./lib/dentalpresence-pairs.js";

const args = process.argv.slice(2); const index = args.indexOf("--out");
if (index < 1 || index !== args.length - 2) throw new Error("Usage: npm run evidence:dentalpresence-pairs -- <artifact-directory> [...] --out <summary.json>");
const directories = args.slice(0, index).map((path) => resolve(path));
const out = resolve(args[index + 1]);
if (directories.some((directory) => ["pair.json", "prediction.json", "prediction-receipt.json"].some((name) => join(directory, name) === out))) throw new Error("Output must not overwrite evidence");
const optional = (path: string) => existsSync(path) ? readFileSync(path) : Buffer.from("");
const report = summarizeDentalPresencePairs(directories.map((directory) => {
  const bytes = optional(join(directory, "pair.json"));
  let pair: unknown = null;
  try { pair = JSON.parse(bytes.toString("utf8")) as unknown; } catch { /* An absent or broken artifact is unavailable. */ }
  return { pair, predictionBytes: optional(join(directory, "prediction.json")), receiptBytes: optional(join(directory, "prediction-receipt.json")) };
}));
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`); console.log(JSON.stringify(report, null, 2));
