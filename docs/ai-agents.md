# DiffCI for AI Coding Agents

DiffCI is a fail-closed verification layer agents run before proposing, committing, or opening a pull
request. It chooses the narrowest verification it can justify and broadens to the full inferred test
command when the evidence is incomplete.

The default command is:

```bash
npx "@diffci.com/diffci@latest" verify --changed --json
```

`verify --changed` snapshots staged, unstaged, and non-ignored untracked content, runs the selected
command or a conservative full fallback, and fails unless that exact snapshot passes and remains
unchanged. Its JSON receipt is designed for agents. Use `check` for paired full-versus-selected
measurement and `observe --no-send` for analysis without test execution.

## Install Agent Instructions

From a repository root:

```bash
npx "@diffci.com/diffci@latest" init
```

This writes:

- `AGENTS.md`
- `CLAUDE.md`
- `.cursor/rules/diffci.mdc`
- `.github/copilot-instructions.md`
- `diffci.config.json`

Existing instruction files are extended with a managed DiffCI rule when possible; unrelated content
is preserved. Pass `--force` only when you intentionally want to replace DiffCI-managed output.

To also add a non-blocking GitHub Actions observer job:

```bash
npx "@diffci.com/diffci@latest" init --workflow
```

Then verify the workflow:

```bash
npx "@diffci.com/diffci@latest" verify-workflow
```

To add a blocking, commit-range verification check instead:

```bash
npx "@diffci.com/diffci@latest" init --verification-workflow
```

The generated check uploads a receipt and intentionally does not use `continue-on-error`. Make its
**DiffCI verification** job required only after it has passed in the repository's normal CI context.

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

Agents that support remote MCP can connect to the stateless, read-only guidance endpoint:

```text
https://diffci.com/mcp
```

To inspect the current checkout or run tests, use the native stdio tool server:

```bash
npx -p "@diffci.com/diffci@latest" diffci-mcp
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

- run `diffci verify --changed --json` before PR-ready answers for local edits;
- run `diffci verify --json` for a clean CI commit range;
- call `diffci_verify_changed` locally or `diffci_verify` in CI when connected through MCP;
- require `safe_to_continue: true` and read the receipt's verification, selected tests, fallback
  reasons, command result, and snapshot identities;
- use DiffCI output to choose focused follow-up validation;
- keep the repository's required CI commands authoritative.

Agents should not:

- skip required CI because DiffCI selected fewer tests;
- treat `REFUSED` or `ERROR` as a passing validation;
- continue after a receipt says `safe_to_continue: false`;
- configure hosted report sending unless the user explicitly supplies an endpoint and token.

## Open Core Boundary

The agent-facing layer belongs in the open-source core: CLI, local reports, JSON output, instruction
files, and the non-blocking GitHub Action. Hosted history, organization dashboards, PR bots, policies,
team analytics, managed runners, and support belong to commercial DiffCI.
