# DiffCI Adoption Outreach

Use this page as the canonical copy source for directory submissions, issues, and pull requests.

## One-Line Description

DiffCI is open-source test-impact analysis for faster CI.

## Short Description

DiffCI finds tests affected by a code change and measures full versus selected runtime so maintainers
can evaluate CI savings. Run `check` locally without an account; it sends nothing by default.
Existing required CI remains authoritative. Test selection counts alone do not prove runtime savings.

## Choose the entry point

Use the CI description above for npm, CI communities, and maintainer outreach. For coding-agent
communities and MCP directories, use this separate description:

> DiffCI verifies a coding agent's current changes with affected tests or conservative full fallback,
> and returns a receipt bound to the tested snapshot. Required CI remains authoritative.

Use `check` for a first CI savings evaluation and `verify --changed --json` for agent verification.
Only `observe` and the Marketplace Action are observation-only; do not describe the entire product
that way. See the [adoption kit](agent-adoption-kit.md) for installation and MCP setup.

## Links

- Website: https://diffci.com/
- Agent docs: https://diffci.com/docs/ai-agents
- MCP docs: https://github.com/DiffCI/DiffCI.com/blob/main/docs/mcp.md
- LLM discovery: https://diffci.com/llms.txt
- npm: https://www.npmjs.com/package/@diffci.com/diffci
- GitHub: https://github.com/DiffCI/DiffCI.com

## Commands

CLI:

```bash
npx "@diffci.com/diffci@latest" check
```

MCP:

```bash
npx -p "@diffci.com/diffci@latest" diffci-mcp
```

## Discovery CTA

Use this in directory descriptions, Marketplace copy, README snippets, and community replies:

~~~md
Try DiffCI locally:

```bash
npx "@diffci.com/diffci@latest" check
```

DiffCI analyzes the current change, runs inferred full and selected commands when safe, writes reports
outside the checkout, and sends nothing by default. Existing CI remains authoritative.
~~~

If someone has already run DiffCI, ask them to open a first-report issue:

~~~md
If you get a useful or confusing result, share the summary here:
https://github.com/DiffCI/DiffCI.com/issues/new?template=first-diffci-report.yml

Please paste only the DiffCI summary or a sanitized report excerpt. Do not paste secrets, private
source, tokens, or credential-bearing CI logs.
~~~

## CI maintainer issue template

Suggested title: **Evaluate affected-test runtime on this repository**

~~~md
DiffCI finds tests affected by a code change and compares full versus selected runtime locally:

```bash
npx "@diffci.com/diffci@latest" check
```

It requires Git and Node.js 22.5+, sends nothing by default, and leaves required CI authoritative.
A full fallback or setup error is useful feedback too. Would a local evaluation be useful here?

Please share a summary or sanitized excerpt using:
https://github.com/DiffCI/DiffCI.com/issues/new?template=first-diffci-report.yml
~~~

## Agent issue template

Title:

```text
Add DiffCI as an optional AI-agent CI validation tool
```

Body:

```md
DiffCI now ships an npm CLI and stdio MCP server for AI coding agents:

- CLI: `npx "@diffci.com/diffci@latest" check`
- MCP: `npx -p "@diffci.com/diffci@latest" diffci-mcp`

For current working-tree verification, run `npx "@diffci.com/diffci@latest" verify --changed --json`.
It executes selected verification or conservative full fallback and returns a snapshot-bound receipt.
Use `check` separately to compare runtimes. Required CI remains authoritative.

Docs:

- https://diffci.com/docs/ai-agents
- https://github.com/DiffCI/DiffCI.com/blob/main/docs/mcp.md

Would you be open to adding DiffCI as an optional validation command/example for AI coding agents?
```

## First-Run Follow-Up

When someone shares a first report, reply with exactly one next step:

| Report result | Reply with |
| --- | --- |
| Selective with a runnable command | Ask whether they want a seven-day non-blocking Action pilot. |
| Full fallback | Explain the fallback reason and ask for a smaller source-changing revision if useful. |
| Refused | Treat it as unsupported or an install/setup issue; do not sell it as an opportunity. |
| Error | Ask for the sanitized error and open a bug if it is reproducible. |
| Paired runtime result | Check command coverage, cache state, exit codes, and checkout provenance before discussing savings. |

After a useful local evaluation, offer `init --install --workflow` for a pinned installation and a
separate non-blocking observation pilot. Review the generated changes with the maintainer. Observation
does not measure runtime savings; use repeated paired comparisons for that evidence. Record a merged
installation as a milestone, then verify subsequent executions before counting recurring adoption.

## PR Snippet

~~~md
### Optional AI-agent validation

Before marking changes PR-ready, agents can run:

```bash
npx "@diffci.com/diffci@latest" check
```

Agents with MCP support can configure:

```bash
npx -p "@diffci.com/diffci@latest" diffci-mcp
```

DiffCI is a validation lens: it explains affected tests and keeps required CI authoritative.
~~~
