# DiffCI adoption kit

Copy only the integration your repository needs. DiffCI does not replace required CI.

## Agent instruction

Add this to `AGENTS.md` or the equivalent agent instruction file:

> Before calling a change PR-ready, run `npx "@diffci.com/diffci@latest" check` from the repository
> root. Use its output to understand affected tests and fallback reasons. Keep the repository's
> required CI authoritative. If DiffCI reports `REFUSED` or `ERROR`, run the normal tests.

`check` may execute the repository's full and selected test commands, which may write generated
files. For analysis without executing tests, run `npx "@diffci.com/diffci@latest" observe --no-send`.

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
      - uses: DiffCI/DiffCI.com@e1d7bab271c5d83899bda0034d70d3e34c10c1f7 # v0.2.11
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

> This adds an optional DiffCI instruction or observation job. DiffCI analyzes the change and
> reports affected tests. Its `check` command compares full and selected test commands when it can
> infer them; the GitHub Action only observes. Required CI continues to run as before.

## Where to point maintainers

- [npm package](https://www.npmjs.com/package/@diffci.com/diffci)
- [GitHub Marketplace Action](https://github.com/marketplace/actions/diffci-observer)
- [Agent guide](https://diffci.com/docs/ai-agents)
- [Context7 CLI documentation](https://context7.com/diffci/diffci.com)
- [Share a first DiffCI report](https://github.com/DiffCI/DiffCI.com/issues/new?template=first-diffci-report.yml)

If a maintainer is evaluating DiffCI for the first time, ask for one local run before proposing a
workflow change:

```bash
npx "@diffci.com/diffci@latest" check
```

Then use the first-report issue template to capture the result, fallback/refusal reasons, CI shape,
and whether a seven-day non-blocking observation pilot would be useful.
