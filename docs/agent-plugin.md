# DiffCI coding-agent plugin

DiffCI ships two agent packages with deliberately different trust boundaries:

- `packaging/agent-plugin` is the local Codex and Claude Code plugin. It uses
  the local stdio MCP server to inspect a selected checkout and, when asked,
  run repository tests.
- `packaging/public-plugin` is the portable public-directory package. It
  connects only to `https://diffci.com/mcp/v1`, which plans commands,
  interprets submitted reports, and checks submitted workflow text. It cannot
  read a local checkout or run tests.

The local package uses the existing CLI and core engine. Node 22.5+ and Git are
required for checkout-aware verification.

## Install after release

Install from the DiffCI repository marketplace for the most direct native
experience. The marketplace source includes the portable package as well as
the Codex and Claude Code compatibility adapters.

Codex:

```bash
codex plugin marketplace add DiffCI/DiffCI.com
codex plugin add diffci@diffci-local
```

For a reviewed release instead of the default branch, use a tag source such as
`DiffCI/DiffCI.com@v<release-version>`. Do not sparse-checkout only `.agents/plugins`:
the marketplace entry also needs `packaging/agent-plugin`.

Claude Code:

```bash
claude plugin marketplace add DiffCI/DiffCI.com
claude plugin install diffci@diffci-marketplace
```

The Git marketplace is available once the matching repository release and npm
package are published. To use the npm package as the marketplace source instead:

```bash
npm install --save-dev @diffci.com/diffci
```

Then register the installed package with the host you use:

```bash
claude plugin marketplace add ./node_modules/@diffci.com/diffci
claude plugin install diffci@diffci-marketplace
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

## Public Codex and ChatGPT directory

The portable package in `packaging/public-plugin` is prepared for OpenAI's
public plugin submission flow. It uses the hosted, read-only MCP endpoint and
its listing text names that boundary explicitly. It cannot replace the local
plugin for checkout-aware verification.

Package that directory as a ZIP after releasing the matching npm/site version,
then follow its [`SUBMISSION.md`](../packaging/public-plugin/SUBMISSION.md).
The portal still requires a verified publisher, domain verification, a demo
recording, connection scanning, and human review before the plugin will appear
in the shared Codex/ChatGPT search directory.

## Claude Code marketplace and directory

The root [`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json)
makes the local plugin installable from DiffCI's own GitHub repository or its
published npm package. The plugin manifest also includes the presentation
metadata needed for Anthropic's directory. With Claude Code 2.1.281 or later,
run the following validation before sharing an update:

```bash
claude plugin validate --strict ./packaging/agent-plugin
claude plugin validate --strict .
```

The self-hosted marketplace does not make DiffCI appear in Anthropic's public
search. Public Claude discovery still requires submission through Anthropic's
directory flow and its review of the exact npm launcher.

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
The package is not publicly listed until the separate OpenAI and Anthropic
directory submissions are approved.

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
