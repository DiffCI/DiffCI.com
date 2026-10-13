# DiffCI local coding-agent plugin

This is the checkout-aware DiffCI package for coding agents. It includes the
portable Agent Plugins manifests (`plugin.json` and `mcp.json`), the Codex
compatibility adapter, and the Claude Code adapter. All launch the same local
stdio MCP server, which inspects the Git repository passed to each tool and can
run the selected or conservative full test command when verification is
requested.

The launcher downloads the exact npm release declared in its MCP manifest.
Install it only after that release has been published. Tools return structured
evidence and preserve required project CI as the final authority.

## Install from the DiffCI marketplace

Codex:

```bash
codex plugin marketplace add DiffCI/DiffCI.com
codex plugin add diffci@diffci-local
```

Claude Code:

```bash
claude plugin marketplace add DiffCI/DiffCI.com
claude plugin install diffci@diffci-marketplace
```

For a release-pinned Codex marketplace, add `@v<release-version>` to the
marketplace source. Other MCP-compatible agents can use the portable package
or the local stdio configuration in [the MCP guide](../../docs/mcp.md).

The separate public hosted DiffCI plugin is intentionally read-only: it plans
commands and interprets supplied evidence, but cannot inspect a local checkout
or run tests.
