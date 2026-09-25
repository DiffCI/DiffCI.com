# DiffCI MCP Server

DiffCI ships a small stdio MCP server for coding agents that prefer native tools over shell commands.

Run it with:

```bash
npx -p "@diffci.com/diffci@latest" diffci-mcp
```

## MCP Client Config

Use this stdio configuration in clients that accept MCP JSON. Set `cwd` to the repository where the
agent should run DiffCI.

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

On Windows, keep the same command shape and use a Windows path:

```json
{
  "mcpServers": {
    "diffci": {
      "command": "npx",
      "args": ["-p", "@diffci.com/diffci@latest", "diffci-mcp"],
      "cwd": "C:\\Users\\you\\path\\to\\repository"
    }
  }
}
```

For Claude Desktop, Claude Code, Cursor, Codex-style MCP clients, and other stdio-compatible agents,
name the server `diffci` and call `diffci_check` before PR-ready answers.

Available tools:

- `diffci_check` - runs `diffci check`, including inferred full and selected test commands.
- `diffci_init` - runs `diffci init` to seed agent instruction files.
- `diffci_verify_workflow` - runs `diffci verify-workflow` to check non-interference.

The MCP server delegates to the same open-source CLI. `diffci_check` sends nothing to DiffCI Cloud,
but it runs test commands when it can infer them. Use the CLI's `observe --no-send` for analysis only.

Keep required project CI authoritative. DiffCI output is a validation lens, not permission to skip
required checks.

## Directory Metadata

Discovery links:

- npm package: https://www.npmjs.com/package/@diffci.com/diffci
- GitHub repository: https://github.com/DiffCI/DiffCI.com
- Agent docs: https://diffci.com/docs/ai-agents
- LLM discovery file: https://diffci.com/llms.txt
- MCP command: `npx -p "@diffci.com/diffci@latest" diffci-mcp`

Short description:

> Change-aware CI/CD validation for AI coding agents. DiffCI analyzes the checkout, can run paired
> full and selected test commands, and keeps required CI authoritative.
