# DiffCI Adoption Outreach

Use this page as the canonical copy source for directory submissions, issues, and pull requests.

## One-Line Description

DiffCI is an observation-only CI/CD validation tool and MCP server for AI coding agents.

## Short Description

DiffCI gives coding agents a safe validation lens before they call work PR-ready. It analyzes the
current checkout, explains affected tests, can run inferred local validation through `diffci check`,
and leaves required CI authoritative.

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

## Issue Template

Title:

```text
Add DiffCI as an optional AI-agent CI validation tool
```

Body:

```md
DiffCI now ships an npm CLI and stdio MCP server for AI coding agents:

- CLI: `npx "@diffci.com/diffci@latest" check`
- MCP: `npx -p "@diffci.com/diffci@latest" diffci-mcp`

It is intended as an optional validation lens before agents mark work PR-ready. DiffCI analyzes the
current checkout, explains affected tests, can run inferred local validation through `diffci check`,
and does not skip, cancel, reorder, or modify required CI.

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
