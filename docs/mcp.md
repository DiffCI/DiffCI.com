# DiffCI MCP Server

DiffCI ships a small stdio MCP server for coding agents that prefer native tools over shell commands.

Run it with:

```bash
npx -p @diffci.com/diffci@latest diffci-mcp
```

Available tools:

- `diffci_check` - runs `diffci check`, the observation-only AI-agent validation command.
- `diffci_init` - runs `diffci init` to seed agent instruction files.
- `diffci_verify_workflow` - runs `diffci verify-workflow` to check non-interference.

The MCP server delegates to the same open-source CLI. `diffci_check` sends nothing by default and does
not run, skip, cancel, or reorder tests.

Keep required project CI authoritative. DiffCI output is a validation lens, not permission to skip
required checks.
