# DiffCI Adoption Metrics

Track adoption weekly after each outreach batch.

## Conversion goal

Every discovery surface should move a maintainer toward one concrete action:

```bash
npx @diffci.com/diffci@latest check
```

The desired conversion is not a directory view. It is a first report that a maintainer can understand,
share, and use to decide whether a seven-day non-blocking observation pilot is worthwhile.

Use the same call to action across npm, GitHub Marketplace, Context7, MCP directories, GitHub, and
community posts:

> Try DiffCI locally with `npx @diffci.com/diffci@latest check`. It analyzes the current change, runs
> inferred full and selected commands when safe, writes reports outside the checkout, and sends nothing
> by default. Existing CI remains authoritative.

Route maintainers who have already run it to the
[`Share a first DiffCI report`](../.github/ISSUE_TEMPLATE/first-diffci-report.yml) issue template.

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

Record each submission in `docs/agent-adoption-targets.md` or a dated note. For directory listings,
track conversion signals, not only application status:

| Channel | Status | Primary CTA | Signal to watch | Next action |
| --- | --- | --- | --- | --- |
| npm | Live | `npx @diffci.com/diffci@latest check` | Weekly downloads, package-page visits, first-report issues | Keep README first-run copy current. |
| GitHub Marketplace | Live | Install non-blocking Action or run local check first | Action installs, workflow questions, first-report issues | Keep pinned SHA and Marketplace copy current. |
| GitHub repository | Live | Open a first-report issue | Stars, issues, forks, discussion quality | Reply quickly and convert strong reports into pilot packets. |
| Context7 | Live | Agent-safe `check` command | Agent docs referrals, copied snippets, MCP questions | Keep agent instructions concise and current. |
| Official MCP Registry | Published | `diffci-mcp` setup | MCP install questions, tool-call reports | Keep package metadata and MCP examples aligned. |
| Glama | Applied | MCP server install | Listing visits, MCP questions | Update copy with exact first-run command once accepted. |
| PulseMCP | Applied | MCP server install | Listing visits, MCP questions | Watch for accepted listing and questions. |
| Smithery | Applied | MCP server install | Listing visits, install attempts | Watch for accepted listing and questions. |
| Libraries.io | Applied | npm package page | Dependency watchers, source referrals | Keep package metadata clean. |
| AlternativeTo | Applied | Local `check` command | Referral visits, comparison comments | Emphasize observation-only CI. |
| StackShare | Applied | Local `check` command | Stack adds, referral visits | Emphasize developer workflow fit. |
| Open Hub | Applied | GitHub repo | Project watchers, referral visits | Keep project metadata accurate. |
| devtools/ | Applied | Local `check` command | Referral visits, first-run issues | Keep one-command CTA visible. |

Weekly loop:

1. Check npm version/downloads, GitHub traffic, Marketplace/listing signals, stars, issues, and opt-in
   usage events.
2. Label first-run reports with `first-report` and record whether they are selective, full fallback,
   refused, or errored.
3. Reply to every first-report issue with one next step: inspect fallback/refusal, repeat with controlled
   cache state, open a non-blocking Action PR, or stop because the repo is unsupported.
4. Move strong candidates into a maintainer review packet and ask for a seven-day pilot.
5. Stop adding new directories unless an existing channel produces reports or maintainer conversations.

Existing outreach log:

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
