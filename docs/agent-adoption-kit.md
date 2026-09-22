# DiffCI Agent Adoption Kit

Use this when adding DiffCI to a repository or opening a small adoption PR.

## One-Sentence Positioning

DiffCI gives AI coding agents a safe default CI/CD validation command.

## Maintainer Install Snippet

```md
## Add DiffCI for AI coding agents

Run:

```bash
npx @diffci.com/diffci@latest init
```

Then ask your coding agent to run:

```bash
npx @diffci.com/diffci@latest check
```

DiffCI check analyzes the change and runs inferred full and selected test commands to measure time.
It writes reports outside the checkout and sends nothing. Test commands may write generated files.
Use `observe --no-send` for analysis only.
```

## Agent Instruction Snippet

```md
Before marking changes PR-ready, run:

```bash
npx @diffci.com/diffci@latest check
```

Use DiffCI output to understand which tests and CI paths are relevant. Do not treat a DiffCI selection
as permission to skip required project CI.
```

## GitHub Search Queries

Find repositories already prepared for coding agents:

```text
filename:AGENTS.md
filename:CLAUDE.md
path:.cursor/rules
filename:copilot-instructions.md
```

Prioritize repositories that:

- use JavaScript, TypeScript, Vue, or Go in a normal GitHub Actions workflow;
- already accept small docs/config PRs;
- have active maintainers and recent CI runs;
- already document agent behavior.

Avoid repositories where:

- CI is security-sensitive and maintainers ask not to add tools;
- there is no clear test command or GitHub Actions setup;
- the project is inactive.

## Small PR Template

```md
Title: Add optional DiffCI instructions for AI coding agents

This adds an optional instruction for coding agents to run DiffCI before marking changes PR-ready.

DiffCI check runs a paired test comparison when commands can be inferred:

- it analyzes the change and writes a local report;
- it sends nothing without explicit configuration;
- it runs full and selected test commands but does not skip required CI;
- the repository's existing required CI remains authoritative.

Default command:

```bash
npx @diffci.com/diffci@latest check
```

This PR does not make DiffCI a required check.
```

## Links

- Agent docs: https://diffci.com/docs/ai-agents.html
- llms.txt: https://diffci.com/llms.txt
- npm: https://www.npmjs.com/package/@diffci.com/diffci
- GitHub release: https://github.com/DiffCI/DiffCI.com/releases/latest
