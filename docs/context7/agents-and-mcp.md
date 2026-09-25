# Coding agent integration

Seed a repository with DiffCI instructions for Codex, Claude Code, Cursor and GitHub Copilot:

```sh
npx "@diffci.com/diffci@latest" init
```

`init` writes agent instruction files and `diffci.config.json`. Existing files are kept unless `--force` is passed. Agents can then run:

```sh
npx "@diffci.com/diffci@latest" check
```

For an MCP client that can run a local stdio server:

```sh
npx -p "@diffci.com/diffci@latest" diffci-mcp
```

The server exposes `diffci_check`, `diffci_init` and `diffci_verify_workflow`. `diffci_check` can execute inferred test commands. Use `observe --no-send` directly in a shell when analysis without test execution is needed. See the [MCP guide](../mcp.md) for details.

DiffCI is an advisory validation lens. Do not skip required CI checks because a smaller selection was proposed. If analysis returns `REFUSED` or `ERROR`, use the repository's normal tests.
