# DiffCI adoption kit

Copy only the integration your repository needs. DiffCI does not replace required CI.

## Agent instruction

Add this to `AGENTS.md` or the equivalent agent instruction file:

> Before calling a change PR-ready, run `npx "@diffci.com/diffci@latest" verify --changed --json`
> from the repository root. Continue only when the receipt says `safe_to_continue: true`. Keep the
> repository's required CI authoritative. If DiffCI refuses, errors, fails, or cannot prove a safe
> selection, run the normal tests and do not treat the change as verified.

`verify --changed` may execute the repository's selected or full test command, which may write
generated files. DiffCI fails if the content-addressed snapshot changes while verification runs. For
paired runtime measurement use `check`; for analysis without tests use `observe --no-send`.

## Blocking GitHub verification

Generate the workflow instead of copying a version-sensitive package command:

```bash
npx "@diffci.com/diffci@latest" init --verification-workflow
```

The generated **DiffCI verification** job verifies the pull-request or push range, has no
`continue-on-error`, and uploads its receipt. After a successful pilot, make that job a required
branch-protection check.

## GitHub Action

Save this as `.github/workflows/diffci.yml` to observe changes in a separate, non-blocking job:

```yaml
name: DiffCI observation
on: [push, pull_request]
permissions:
  contents: read
jobs:
  diffci:
    runs-on: ubuntu-latest
    continue-on-error: true
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: DiffCI/DiffCI.com@2f72b7fc017cc987fb0fd80c7e2351f33240e7d4 # v0.3.0-rc.1
```

Run `npx "@diffci.com/diffci@latest" verify-workflow` before starting a pilot. The Action uploads a
GitHub artifact by default; it sends nothing to DiffCI Cloud without an explicit endpoint and token.

## MCP client

For a client that accepts stdio MCP JSON, set `cwd` to the repository checkout:

```json
{
  "mcpServers": {
    "diffci": {
      "command": "npx",
      "args": ["-p", "@diffci.com/diffci@latest", "diffci-mcp"],
      "cwd": "/path/to/repository"
    }
  }
}
```

See [MCP setup](mcp.md) for Windows paths and the available tools.

## Small adoption PR

Suggested title: **Add optional DiffCI validation for coding agents**

Suggested description:

> This adds a persistent DiffCI agent instruction and optionally a blocking verification job. DiffCI
> runs the minimum test command it can justify, falls back to full verification on uncertainty, and
> emits a machine-readable receipt. Required CI continues to run as before.

## Where to point maintainers

- [npm package](https://www.npmjs.com/package/@diffci.com/diffci)
- [GitHub Marketplace Action](https://github.com/marketplace/actions/diffci-observer)
- [Agent guide](https://diffci.com/docs/ai-agents)
- [Context7 CLI documentation](https://context7.com/diffci/diffci.com)
- [Share a first DiffCI report](https://github.com/DiffCI/DiffCI.com/issues/new?template=first-diffci-report.yml)

If a maintainer is evaluating DiffCI for the first time, ask for one local run before proposing a
workflow change:

```bash
npx "@diffci.com/diffci@latest" verify --changed --json
```

Then use the first-report issue template to capture the result, fallback/refusal reasons, CI shape,
and whether a seven-day non-blocking observation pilot would be useful.
