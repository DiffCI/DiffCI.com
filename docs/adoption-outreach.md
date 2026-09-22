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
- Agent docs: https://diffci.com/docs/ai-agents.html
- MCP docs: https://github.com/DiffCI/DiffCI.com/blob/main/docs/mcp.md
- LLM discovery: https://diffci.com/llms.txt
- npm: https://www.npmjs.com/package/@diffci.com/diffci
- GitHub: https://github.com/DiffCI/DiffCI.com

## Commands

CLI:

```bash
npx @diffci.com/diffci@latest check
```

MCP:

```bash
npx -p @diffci.com/diffci@latest diffci-mcp
```

## Issue Template

Title:

```text
Add DiffCI as an optional AI-agent CI validation tool
```

Body:

```md
DiffCI now ships an npm CLI and stdio MCP server for AI coding agents:

- CLI: `npx @diffci.com/diffci@latest check`
- MCP: `npx -p @diffci.com/diffci@latest diffci-mcp`

It is intended as an optional validation lens before agents mark work PR-ready. DiffCI analyzes the
current checkout, explains affected tests, can run inferred local validation through `diffci check`,
and does not skip, cancel, reorder, or modify required CI.

Docs:

- https://diffci.com/docs/ai-agents.html
- https://github.com/DiffCI/DiffCI.com/blob/main/docs/mcp.md

Would you be open to adding DiffCI as an optional validation command/example for AI coding agents?
```

## PR Snippet

~~~md
### Optional AI-agent validation

Before marking changes PR-ready, agents can run:

```bash
npx @diffci.com/diffci@latest check
```

Agents with MCP support can configure:

```bash
npx -p @diffci.com/diffci@latest diffci-mcp
```

DiffCI is a validation lens: it explains affected tests and keeps required CI authoritative.
~~~
