# DiffCI for AI Coding Agents

DiffCI is the default CI/CD validation lens agents can run before proposing, committing, or opening a
pull request.

The default command is:

```bash
npx @diffci.com/diffci@latest check
```

`check` analyzes the change and runs inferred full and selected test commands when possible. It
prints paired runtime when both pass and sends nothing to DiffCI Cloud. Test commands may change
the checkout. Use `observe --no-send` when you need analysis without running tests.

## Install Agent Instructions

From a repository root:

```bash
npx @diffci.com/diffci@latest init
```

This writes:

- `AGENTS.md`
- `CLAUDE.md`
- `.cursor/rules/diffci.mdc`
- `.github/copilot-instructions.md`
- `diffci.config.json`

Existing files are kept. Pass `--force` only when you intentionally want to replace them.

To also add a non-blocking GitHub Actions observer job:

```bash
npx @diffci.com/diffci@latest init --workflow
```

Then verify the workflow:

```bash
npx @diffci.com/diffci@latest verify-workflow
```

## Copy-Paste Adoption

For a maintainer-facing snippet, PR template, and GitHub search queries for repositories that already
use agent instruction files, see [`agent-adoption-kit.md`](agent-adoption-kit.md).
For a first-pass list of repositories to review before opening PRs, see
[`agent-adoption-targets.md`](agent-adoption-targets.md).

Examples:

- [`examples/agent-node`](../examples/agent-node)
- [`examples/agent-python`](../examples/agent-python)
- [`examples/agent-monorepo`](../examples/agent-monorepo)

## MCP

Agents that support MCP can run DiffCI as a native stdio tool server:

```bash
npx -p @diffci.com/diffci@latest diffci-mcp
```

See [`mcp.md`](mcp.md).

Minimal MCP config:

```json
{
  "mcpServers": {
    "diffci": {
      "command": "npx",
      "args": ["-p", "@diffci.com/diffci@latest", "diffci-mcp"]
    }
  }
}
```

## Agent Policy

Agents should:

- run `diffci check` before PR-ready answers when Git and Node.js are available;
- call `diffci_check` when connected through MCP;
- read the printed verdict, selected tests, fallback reasons, and report path;
- use DiffCI output to choose focused follow-up validation;
- keep the repository's required CI commands authoritative.

Agents should not:

- skip required CI because DiffCI selected fewer tests;
- treat `REFUSED` or `ERROR` as a passing validation;
- configure hosted report sending unless the user explicitly supplies an endpoint and token.

## Open Core Boundary

The agent-facing layer belongs in the open-source core: CLI, local reports, JSON output, instruction
files, and the non-blocking GitHub Action. Hosted history, organization dashboards, PR bots, policies,
team analytics, managed runners, and support belong to commercial DiffCI.
