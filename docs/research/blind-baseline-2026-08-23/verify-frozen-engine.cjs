// Re-verifies that every engine/harness file still matches the frozen build manifest. Exit 1 on drift.
// `--manifest <path>` (used in-container) verifies against a trusted manifest downloaded from R2 instead
// of the copy beside this file; without the flag the original behaviour (manifest beside this file) applies.
const fs = require("fs"); const crypto = require("crypto"); const path = require("path");
const root = path.resolve(__dirname, "..", "..", "..");
const manifestArg = process.argv.indexOf("--manifest");
const manifestPath = manifestArg !== -1 && process.argv[manifestArg + 1]
  ? process.argv[manifestArg + 1]
  : path.join(__dirname, "2026-08-23-diffci-frozen-build-manifest.json");
const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
let drift = 0;
for (const [f, info] of Object.entries(m.engineFiles)) {
  const now = crypto.createHash("sha256").update(fs.readFileSync(path.join(root, f))).digest("hex");
  const ok = now === info.sha256; if (!ok) drift++;
  console.log((ok ? "OK   " : "DRIFT") + " " + f + (ok ? "" : ` (${now.slice(0, 12)} != ${info.sha256.slice(0, 12)})`));
}
const combined = crypto.createHash("sha256").update(Object.keys(m.engineFiles).sort().map((f) => f + ":" + crypto.createHash("sha256").update(fs.readFileSync(path.join(root, f))).digest("hex")).join("\n")).digest("hex");
console.log("engineChecksum now " + combined.slice(0, 16) + " frozen " + m.engineChecksum.slice(0, 16) + (combined === m.engineChecksum ? " MATCH" : " MISMATCH"));
process.exit(drift ? 1 : 0);
