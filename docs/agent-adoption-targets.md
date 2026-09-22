# Agent Adoption Targets

Generated 2026-09-21 from GitHub search for repositories already centered on `AGENTS.md`,
`CLAUDE.md`, Cursor/Codex/Claude Code workflows, or agent instruction templates.

Do not open drive-by PRs blindly. Review each repository's contribution policy first and use the
small optional-instruction PR from [`agent-adoption-kit.md`](agent-adoption-kit.md).

## Best First Targets

| Repository | Why it fits |
| --- | --- |
| [`agentsmd/agents.md`](https://github.com/agentsmd/agents.md) | Defines the `AGENTS.md` convention. Proposal opened: [#245](https://github.com/agentsmd/agents.md/issues/245). |
| [`FerroxLabs/agents-md`](https://github.com/FerroxLabs/agents-md) | Explicitly targets Claude Code, Codex, Gemini, Cursor, and verification loops. Proposal opened: [#2](https://github.com/FerroxLabs/agents-md/issues/2). |
| [`ciembor/agent-rules-books`](https://github.com/ciembor/agent-rules-books) | Curated rules for AI coding agents; proposal opened: [#8](https://github.com/ciembor/agent-rules-books/issues/8). |
| [`jbarbier/CLAUDE.md`](https://github.com/jbarbier/CLAUDE.md) | Drop-in Claude/Codex/Cursor instruction file; proposal opened: [#12](https://github.com/jbarbier/CLAUDE.md/issues/12). |
| [`agent-sh/agnix`](https://github.com/agent-sh/agnix) | Linter/LSP for agent instruction files; possible future integration target. |
| [`jsynowiec/node-typescript-boilerplate`](https://github.com/jsynowiec/node-typescript-boilerplate) | Real Node/TypeScript boilerplate with GitHub Actions and `AGENTS.md`, useful as a practical adoption example. |

## Secondary Targets

| Repository | Why it fits |
| --- | --- |
| [`BayramAnnakov/claude-reflect`](https://github.com/BayramAnnakov/claude-reflect) | Syncs learning into `CLAUDE.md` and `AGENTS.md`; validation-command guidance may fit. |
| [`josix/awesome-claude-md`](https://github.com/josix/awesome-claude-md) | Curated collection; submit DiffCI as a validation-pattern example. |
| [`TheDecipherist/claude-code-mastery`](https://github.com/TheDecipherist/claude-code-mastery) | Guide-style repo; useful place for the agent-safe validation command. |
| [`microsoft/skills`](https://github.com/microsoft/skills) | Agent skills and MCP ecosystem. Higher bar; review contribution rules before proposing. |
| [`mxyhi/ok-skills`](https://github.com/mxyhi/ok-skills) | Curated skills/playbooks for Codex, Claude Code, Cursor, and other tools. |

## MCP Directory Targets

| Directory | Submission path | Status |
| --- | --- | --- |
| [Official MCP Registry](https://github.com/modelcontextprotocol/registry) | Published with `mcp-publisher` as `io.github.adityankale190895/diffci`. | Published. |
| [Glama](https://glama.ai/) | Submit the GitHub repository URL and short description; optional `glama.json` metadata can improve indexing. | Ready to submit. |
| [Smithery](https://smithery.ai/) | Publish through Smithery's server release flow/API. | Needs Smithery account/API key. |
| [PulseMCP](https://www.pulsemcp.com/) | Submit/list the MCP server if their current listing flow accepts third-party servers. | Review current submission rules first. |
| [MCP Central](https://mcpcentral.io/) | Follow the interactive server submission flow. | Ready to submit. |

## PR Order

1. Start with documentation/example repos, not large application repos.
2. Add only an optional validation instruction, never a required check.
3. Link to `https://diffci.com/docs/ai-agents.html` and `https://diffci.com/llms.txt`.
4. State that DiffCI sends nothing by default and changes no CI behavior.
5. If maintainers ask for a workflow, suggest `npx @diffci.com/diffci@latest init --workflow`.

## Minimal Patch Shape

Add this to the repository's agent instruction file:

```md
Before marking changes PR-ready, run:

```bash
npx @diffci.com/diffci@latest check
```

DiffCI check analyzes the change and runs inferred full and selected test commands to measure time.
It writes reports outside the checkout and sends nothing. Test commands may write generated files.
Existing required CI remains authoritative; use `observe --no-send` for analysis only.
```
