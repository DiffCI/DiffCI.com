import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { resolveDentalPresenceRepoPath } from "./target-repo.js";

// Exercise the current local DiffCI build against its real application design partner.
const args = process.argv.slice(2);
if (args.some((arg) => /^--(?:repo|share-usage)(?:=|$)/.test(arg))) {
  throw new Error("This command fixes the DentalPresence target and disables telemetry sending");
}
const child = spawn(process.execPath, [
  "--import", "tsx", resolve(import.meta.dirname, "../src/client/cli.ts"),
  "check", ...args, "--repo", resolveDentalPresenceRepoPath(), "--no-send",
], { cwd: resolve(import.meta.dirname, ".."), env: { ...process.env, DIFFCI_SHARE_USAGE: "0" }, stdio: "inherit" });
child.once("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.once("close", (code) => { process.exitCode = code ?? 1; });
