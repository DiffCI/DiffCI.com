---
name: diffci-remote
description: Use DiffCI's hosted MCP tools for conservative CI planning, report interpretation, and workflow isolation guidance.
---

Use this skill when the user supplies a DiffCI observation report, a GitHub
Actions workflow document, or asks for a safe local DiffCI command plan.

- Call `diffci_validation_plan` to create a command. It does not access a
  repository or execute the command it returns.
- Call `diffci_interpret_report` only with a supplied
  `diffci.observation.v1` report. Report the status, selection or full fallback,
  fallback reasons, and the conservative next action.
- Call `diffci_verify_workflow_text` with one workflow YAML document. Treat its
  result as an advisory; it cannot see other files or workflows in the repo.

Never claim that this hosted service inspected a local checkout, executed
tests, produced a verified receipt, or made required CI optional. For those
tasks, use the local DiffCI CLI or local stdio MCP server.
