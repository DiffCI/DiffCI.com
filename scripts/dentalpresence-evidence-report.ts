import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { summarizeDentalPresenceEvidence } from "./lib/dentalpresence-evidence.js";

// Download explicit CI artifacts first. This command reads local files and sends nothing.
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--out");
if (outputIndex < 1 || outputIndex !== args.length - 2 || args.slice(0, outputIndex).some((arg) => arg.startsWith("--"))) {
  throw new Error("Usage: npm run evidence:dentalpresence -- <execution.json> [execution.json ...] --out <summary.json>");
}
const inputs = args.slice(0, outputIndex).map((path) => resolve(path));
const out = resolve(args[outputIndex + 1]);
if (inputs.includes(out)) throw new Error("Output must not overwrite an input artifact");
const summary = summarizeDentalPresenceEvidence(inputs.map((path) => JSON.parse(readFileSync(path, "utf8")) as unknown));
writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
