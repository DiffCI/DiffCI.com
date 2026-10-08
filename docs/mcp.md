# DiffCI MCP Servers

The open-source engine is [DiffCI/core](https://github.com/DiffCI/core). Star it to support the project; watch Releases and Discussions for support and benchmark updates. [Volunteer a pilot repository](https://diffci.com/#pilot).

DiffCI provides a public Streamable HTTP endpoint for read-only validation guidance:

```text
https://diffci.com/mcp
```

Add that URL to clients that accept remote HTTPS MCP servers. It exposes:

- `diffci_validation_plan` for safe local command planning;
- `diffci_interpret_report` for validating and summarizing `diffci.observation.v1` reports;
- `diffci_verify_workflow_text` for a preliminary, stateless GitHub Actions isolation check;
- the `diffci_validate_change` prompt and agent-policy/setup resources.

The endpoint is stateless, needs no credentials, and does not execute a command. It receives no
repository content unless a caller explicitly supplies a report or workflow document to a tool.

Copyable Codex, Claude Code, Cursor, and VS Code setup is at https://diffci.com/mcp-server.

## MCPRush gateway analytics

MCPRush connects to `https://diffci.com/mcp/mcprush` using its `x-mcprush-token` header.
The site Worker validates this against the `MCPRUSH_GATEWAY_TOKEN` Cloudflare secret and
refuses requests when the secret or matching header is missing. Store the token using
`wrangler secret put MCPRUSH_GATEWAY_TOKEN --config wrangler.site.jsonc`; never commit it.

This route exposes the same three hosted guidance tools as the public endpoint. MCPRush
can count calls routed through its gateway; local CLI/stdio verification and direct public
endpoint traffic are outside those analytics. Reports or workflow text a caller explicitly
submits through the gateway pass through MCPRush before reaching DiffCI.

## Local Checkout Tools

DiffCI also ships a stdio MCP server. Use it when MCP tools must inspect the current checkout or run
tests:

Run it with:

```bash
npx -p "@diffci.com/diffci@latest" diffci-mcp
```

## Stdio MCP Client Config

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
name the server `diffci` and call the verification tool that matches the change scope before PR-ready
answers.

Available tools:

- `diffci_verify_changed` - verifies staged, unstaged, and non-ignored untracked changes and returns a
  machine-readable, content-bound receipt.
- `diffci_verify` - verifies a clean commit range, resolving the CI range automatically or accepting
  explicit base and head revisions.
- `diffci_check` - runs `diffci check`, including inferred full and selected test commands.
- `diffci_init` - runs `diffci init` to seed agent instruction files.
- `diffci_verify_workflow` - runs `diffci verify-workflow` to check non-interference.

The verification tools return the same `diffci.verification.v1` receipt as the CLI, including
`verification`, `safe_to_continue`, change and selection counts, fallback reasoning, the executed
command result, and checkout identities. The stdio MCP server delegates to the same open-source CLI
and sends nothing to DiffCI Cloud. Verification runs repository test commands; use the CLI's
`observe --no-send` for analysis only.

Keep required project CI authoritative. DiffCI output is a validation lens, not permission to skip
required checks.

## Directory Metadata

Discovery links:

- npm package: https://www.npmjs.com/package/@diffci.com/diffci
- GitHub repository: https://github.com/DiffCI/DiffCI.com
- Agent docs: https://diffci.com/docs/ai-agents
- LLM discovery file: https://diffci.com/llms.txt
- MCP command: `npx -p "@diffci.com/diffci@latest" diffci-mcp`
- HTTPS MCP endpoint: https://diffci.com/mcp

Short description:

> Fail-closed, change-aware verification for AI coding agents. DiffCI selects the minimum justified
> test command, broadens to full verification on uncertainty, and returns a machine-readable receipt.

See [agent-plugin.md](agent-plugin.md) for Claude Code and Codex installation.
