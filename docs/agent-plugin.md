# DiffCI coding-agent plugin

One package in `packaging/agent-plugin` supports Claude Code and Codex through
their respective manifests, a shared skill, and the same local stdio MCP server.
It uses the existing CLI and core engine. No additional engine or cloud service
is required. Node 22.5+ and Git are required.

## Install after release

```bash
npm install --save-dev @diffci.com/diffci
```

Claude Code:

```bash
claude --plugin-dir ./node_modules/@diffci.com/diffci/packaging/agent-plugin
```

Codex:

```bash
codex plugin marketplace add ./node_modules/@diffci.com/diffci
codex plugin add diffci@diffci-local
```

Both integrations use the shared skill automatically when applicable, and it can
also be invoked explicitly (`/diffci:diffci-verify` in Claude Code).
These commands require an npm release containing this implementation; use the
local development steps below before release.

## Local development

Build the checkout with `npm run build:client`. For testing unreleased tools, copy
the plugin directory outside the repository and change the copy's `.mcp.json`
server to `command: "node"` with `args` containing the absolute path to
`dist-client/src/client/mcp.js` in this checkout. The checked-in npm configuration
pins the package version; new tools become available through npm after release.

Claude Code can load the copy with `claude --plugin-dir /absolute/path/to/plugin`.
For Codex, this checkout includes a repo marketplace at
`.agents/plugins/marketplace.json`. Register the checkout with
`codex plugin marketplace add /absolute/path/to/DiffCI.com`, then install
`diffci@diffci-local` with `codex plugin add diffci@diffci-local` or use the
Plugins UI. The marketplace entry does not enable the plugin automatically.
For an unreleased build, use the copied plugin in a separate local marketplace
with its `source.path` pointing to that copy. Otherwise register the MCP server directly
and copy `skills/diffci-verify` into your personal Codex skills directory.
Always pass the edited repository's absolute path as the tool's `repo` argument;
the server process may start outside that repository.

Installing an npm package alone does not install an agent plugin. Install or load
the plugin explicitly to enable skill discovery. This first version uses skill
discovery and explicit invocation; it does not impose automatic lifecycle hooks.
The package has not been submitted to either public plugin directory.

## Tools

`diffci_changed_files` returns `diffci.agent-changes.v1` with current paths and
tree identity, without building a dependency graph.
`diffci_select_tests` and `diffci_explain_selection`
return `diffci.agent-selection.v1`: current changed paths, tree identity,
selected test files, executable command, and fallback reasons. They do not run
tests. A full fallback's test count describes the discovered universe; its
`selected_tests` list is empty because no narrower selection is claimed.

`diffci_run_affected_tests` delegates to `verify --changed --json`, returning
`diffci.verification.v1`. It reanalyzes rather than trusting a previous plan and
checks the snapshot before and after execution. Unknown analysis blocks;
uncertain selection broadens to the repository's full command when available.
Required CI checks remain authoritative. All four tools operate on uncommitted
changes relative to HEAD. Use `diffci_verify` for committed ranges.

The server accepts standard newline-delimited MCP stdio messages and retains
legacy Content-Length framing for existing clients. No telemetry is sent by these
four tools. Repository-defined test commands may write generated files or use the
network as they normally would.

Manifest references: [Codex packaging](https://developers.openai.com/plugins/build/plugins)
and [Claude Code plugins](https://code.claude.com/docs/en/plugins-reference).
