# DiffCI MCP Server

DiffCI ships a small stdio MCP server for coding agents that prefer native tools over shell commands.

Run it with:

```bash
npx -p @diffci.com/diffci@latest diffci-mcp
```

Available tools:

- `diffci_check` - runs `diffci check`, including inferred full and selected test commands.
- `diffci_init` - runs `diffci init` to seed agent instruction files.
- `diffci_verify_workflow` - runs `diffci verify-workflow` to check non-interference.

The MCP server delegates to the same open-source CLI. `diffci_check` sends nothing to DiffCI Cloud,
but it runs test commands when it can infer them. Use the CLI's `observe --no-send` for analysis only.

Keep required project CI authoritative. DiffCI output is a validation lens, not permission to skip
required checks.
