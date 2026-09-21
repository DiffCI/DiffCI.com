# DiffCI for AI Coding Agents

DiffCI is the default CI/CD validation lens agents can run before proposing, committing, or opening a
pull request.

The safe default command is:

```bash
npx @diffci.com/diffci@latest check
```

`check` is an alias for `observe --no-send`. It analyzes the change and prints a report summary without
running tests, skipping tests, cancelling jobs, changing the checkout, or sending data to DiffCI Cloud.

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

## Agent Policy

Agents should:

- run `diffci check` before PR-ready answers when Git and Node.js are available;
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
