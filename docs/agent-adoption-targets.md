# Agent Adoption Targets

Generated 2026-09-21 from GitHub search for repositories already centered on `AGENTS.md`,
`CLAUDE.md`, Cursor/Codex/Claude Code workflows, or agent instruction templates.

Do not open drive-by PRs blindly. Review each repository's contribution policy first and use the
small optional-instruction PR from [`agent-adoption-kit.md`](agent-adoption-kit.md).

## Best First Targets

| Repository | Why it fits |
| --- | --- |
| [`agentsmd/agents.md`](https://github.com/agentsmd/agents.md) | Defines the `AGENTS.md` convention. A DiffCI example would reach the broadest agent-instruction audience. |
| [`FerroxLabs/agents-md`](https://github.com/FerroxLabs/agents-md) | Explicitly targets Claude Code, Codex, Gemini, Cursor, and verification loops. |
| [`ciembor/agent-rules-books`](https://github.com/ciembor/agent-rules-books) | Curated rules for AI coding agents; good fit for a validation command snippet. |
| [`jbarbier/CLAUDE.md`](https://github.com/jbarbier/CLAUDE.md) | Drop-in Claude/Codex/Cursor instruction file; likely accepts concise validation guidance. |
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

## PR Order

1. Start with documentation/example repos, not large application repos.
2. Add only an optional validation instruction, never a required check.
3. Link to `https://diffci.com/docs/ai-agents.html` and `https://diffci.com/llms.txt`.
4. State that DiffCI sends nothing and changes no CI behavior by default.
5. If maintainers ask for a workflow, suggest `npx @diffci.com/diffci@latest init --workflow`.

## Minimal Patch Shape

Add this to the repository's agent instruction file:

```md
Before marking changes PR-ready, run:

```bash
npx @diffci.com/diffci@latest check
```

DiffCI is observation-only by default: it analyzes the change, writes a report outside the checkout,
sends nothing unless explicitly configured, and does not run, skip, cancel, or reorder tests. Existing
required CI remains authoritative.
```
