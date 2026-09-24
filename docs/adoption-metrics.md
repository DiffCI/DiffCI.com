# DiffCI Adoption Metrics

Track adoption weekly after each outreach batch.

## Opt-in CLI usage

Users can run `diffci check --share-usage` or set `DIFFCI_SHARE_USAGE=1` for `check` and
`observe`. `--no-send` overrides the opt-in. The CLI sends one HTTPS event after analysis to
`https://app.diffci.com/v1/usage-events` with only the command (`check` or `observe`), analysis
outcome (`observed`, `refused`, or `error`), and package version. It sends no repository identity,
paths, commits, test names, report, token, or stable installation identifier. Delivery failure is
best effort and cannot fail validation. The product Worker records `cli_usage_opt_in` in PostHog
when its existing `POSTHOG_API_KEY` is configured.

Count these events as **opted-in executions**, not unique users or repositories. Report the opt-in
count separately from npm downloads and external merged integrations. Because there is no stable
identifier, repeated runs by one user cannot be deduplicated. Network providers may still observe
connection metadata such as IP address.

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
| 2026-09-22 | Official MCP Registry | Directory | `io.github.adityankale190895/diffci` | Published | Consider moving to `io.github.DiffCI/diffci` after GitHub org namespace authorization is available. |
| 2026-09-22 | Glama | Directory | TBD | Planned | Submit repository URL. |
| 2026-09-22 | Smithery | Directory | TBD | Blocked | Needs Smithery account/API key. |

Use merged PRs and accepted directory listings as the primary adoption signal. Use stars, downloads,
and page views as supporting indicators, not proof that agents are actually using DiffCI.
