/**
 * Uploads the current diffci source tree as a tarball to the research Worker's R2 bucket
 * (POST /v1/shadow/source), where the autonomous shadow-cron runner (shadow-cron.ts) pulls it for
 * every scheduled poll. Run this after any change to src/ or scripts/ that should be live in shadow
 * polling - the cron always uses the LAST uploaded snapshot, not the working tree, so an un-uploaded
 * fix silently keeps the old behavior in production polls.
 *
 * Usage: npx tsx scripts/upload-shadow-source.ts --url https://<worker-host> [--label <note>]
 *   The bearer token is read from the RESEARCH_DISPATCH_TOKEN environment variable (never a CLI arg -
 *   argv is visible in process listings; same rule as the Worker's own GITHUB_TOKEN handling).
 */
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith("--")) args[arg.slice(2)] = argv[++i] ?? "";
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = args.url || process.env.DIFFCI_RESEARCH_SANDBOX_URL;
  const token = process.env.RESEARCH_DISPATCH_TOKEN;
  if (!url) throw new Error("--url (or DIFFCI_RESEARCH_SANDBOX_URL) required - the deployed diffci-research-sandbox Worker URL");
  if (!token) throw new Error("RESEARCH_DISPATCH_TOKEN environment variable required");

  const repoRoot = resolve(import.meta.dirname, "..");
  // A RELATIVE output path inside the already-excluded .diffci/ dir, on purpose: an absolute Windows
  // path (C:\...) makes MSYS GNU tar treat "C" as a remote hostname ("Cannot connect to C: resolve
  // failed"), and bsdtar/GNU-tar disagree on --force-local - a relative path works in both.
  mkdirSync(join(repoRoot, ".diffci"), { recursive: true });
  const tarballRelPath = ".diffci/shadow-source-upload.tgz";
  const tarballPath = join(repoRoot, tarballRelPath);
  try {
    // Same exclusions the manual /v1/validate driver flow used: ship the source and lockfile, never
    // node_modules (the container runs its own npm ci) or local research artifacts.
    execSync(
      `tar --exclude=node_modules --exclude=.git --exclude=.diffci --exclude=dist -czf ${tarballRelPath} .`,
      { cwd: repoRoot, stdio: "inherit" },
    );
    const bytes = readFileSync(tarballPath);
    console.log(`tarball: ${(bytes.byteLength / 1024 / 1024).toFixed(2)} MB`);

    const label = args.label || execSync("git rev-parse --short HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();
    const form = new FormData();
    form.set("source", new File([bytes], "diffci-source.tgz"), "diffci-source.tgz");
    form.set("label", label);

    const res = await fetch(`${url.replace(/\/$/, "")}/v1/shadow/source`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`upload failed (${res.status}): ${body.slice(0, 500)}`);
    console.log(`uploaded: ${body}`);
  } finally {
    rmSync(tarballPath, { force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
