# Alpha install smoke 01

**Date:** 2026-09-19T13:34:12.943Z

This evidence records a clean public npm install smoke for the Tidelift-ready DiffCI Core release. The package under test is the public npm package `@diffci.com/diffci` at the `latest` dist-tag.

## Commands

```bash
npx @diffci.com/diffci@latest version
npx @diffci.com/diffci@latest observe --help
npm view @diffci.com/diffci version license dist-tags repository --json
```

## `npx @diffci.com/diffci@latest version`

```text
0.1.3
```

## `npx @diffci.com/diffci@latest observe --help`

```text
diffci - observation-only change-aware CI analysis

Usage:
  diffci observe [--repo <path>] [--out <file>] [--base <sha> --head <sha>]
                 [--redact-paths] [--json] [--quiet] [--fail-on-error]
                 [--api-url <url> --api-token <token>] [--no-send]
  diffci verify-workflow [--repo <path>]
  diffci version

observe analyses the checkout and writes one JSON report. It runs nothing and changes nothing.
verify-workflow checks that the job running DiffCI cannot affect any other job, and exits 1 if it can.

The report is sent only when both --api-url and --api-token are given (or DIFFCI_API_URL and
DIFFCI_TOKEN are set). A failed send is reported and never fails the step - the report is on disk
either way. Plain http is refused; the token is never printed.
```

## `npm view @diffci.com/diffci version license dist-tags repository --json`

```json
{
  "version": "0.1.3",
  "license": "AGPL-3.0-only",
  "dist-tags": {
    "alpha": "0.1.0-alpha.4",
    "latest": "0.1.3"
  },
  "repository": {
    "url": "git+https://github.com/DiffCI/DiffCI.com.git",
    "type": "git"
  }
}
```

## Result

The public npm package installed through `npx`, exposed the expected CLI surface, and the npm registry reported `latest` as `0.1.3` with the public repository metadata.
