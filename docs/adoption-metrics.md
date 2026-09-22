# DiffCI Adoption Metrics

Track adoption weekly after each outreach batch.

## Package

- npm latest version: `npm view "@diffci.com/diffci" version`
- npm weekly downloads: `npm view "@diffci.com/diffci" downloads`
- MCP binary presence: `npm view "@diffci.com/diffci" bin --json`

## Repository

- GitHub stars, forks, watchers, and release views.
- Issues or PRs opened by users asking about `diffci check`, `diffci init`, or `diffci-mcp`.
- External PRs merged that mention DiffCI agent validation.

## Site

- Visits to `https://diffci.com/docs/ai-agents.html`.
- Visits to `https://diffci.com/llms.txt`.
- Clicks from the homepage agent and MCP links.
- Referrers from MCP directories, awesome lists, and agent-template repositories.

## Outreach

Record each submission in `docs/agent-adoption-targets.md` or a dated note:

| Date | Target | Type | Link | Status | Follow-up |
| --- | --- | --- | --- | --- | --- |
| 2026-09-22 | agentsmd/agents.md | Issue | https://github.com/agentsmd/agents.md/issues/245 | Open | Watch for maintainer preference: issue, PR, or no listing. |
| 2026-09-22 | FerroxLabs/agents-md | Issue | https://github.com/FerroxLabs/agents-md/issues/2 | Open | Offer a PR if maintainer wants exact wording. |
| 2026-09-22 | ciembor/agent-rules-books | Issue | https://github.com/ciembor/agent-rules-books/issues/8 | Open | Offer a PR if maintainer wants exact wording. |
| 2026-09-22 | jbarbier/CLAUDE.md | Issue | https://github.com/jbarbier/CLAUDE.md/issues/12 | Open | Offer a PR if maintainer wants exact wording. |
| 2026-09-22 | Official MCP Registry | Directory | TBD | Planned | Prepare publisher metadata. |
| 2026-09-22 | Glama | Directory | TBD | Planned | Submit repository URL. |
| 2026-09-22 | Smithery | Directory | TBD | Blocked | Needs Smithery account/API key. |

Use merged PRs and accepted directory listings as the primary adoption signal. Use stars, downloads,
and page views as supporting indicators, not proof that agents are actually using DiffCI.
