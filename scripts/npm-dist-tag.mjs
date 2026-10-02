#!/usr/bin/env node

export function npmDistTagForVersion(version) {
  const match = /^\d+\.\d+\.\d+-([0-9A-Za-z-]+)(?:\.[0-9A-Za-z-]+)*$/.exec(version);
  if (!match) throw new Error(`expected a semantic-version prerelease, received ${JSON.stringify(version)}`);
  if (match[1] === "alpha" || match[1] === "beta") return match[1];
  return "next";
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replaceAll("\\", "/")}`).href) {
  try {
    console.log(npmDistTagForVersion(process.argv[2] ?? ""));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
