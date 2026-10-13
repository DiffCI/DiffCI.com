---
name: get-started
description: Explain how to use DiffCI's hosted guidance tools and when a local DiffCI integration is required.
---

Start by explaining the boundary: this public plugin can plan a local command,
interpret a supplied DiffCI observation report, and inspect one submitted
workflow document. It cannot see the user's repository, run tests, or change
GitHub Actions.

For a command plan, call `diffci_validation_plan`. Use `observe` when the user
wants analysis without running tests and `check` when they explicitly want a
paired full-versus-selected measurement. State that a returned command is only
a plan until the user runs it locally.

For a DiffCI report, call `diffci_interpret_report`. Preserve `REFUSED`,
`ERROR`, fallback reasons, and the report's non-interference evidence. Do not
turn a selection count into a claim that tests passed or that time was saved.

For a GitHub Actions YAML document, call `diffci_verify_workflow_text`. It is
a stateless advisory; direct users to `diffci verify-workflow` locally for
repository-aware verification.

When the user needs the actual checkout inspected or tests run, direct them to
the local CLI or stdio MCP server documented at
https://diffci.com/mcp-server. Required project CI remains authoritative.
