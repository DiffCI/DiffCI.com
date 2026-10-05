# DiffCI Adoption Metrics

Track adoption weekly after each outreach batch.

## Conversion goal

Every discovery surface should move a maintainer toward one concrete action:

```bash
npx "@diffci.com/diffci@latest" check
```

The desired conversion is not a directory view. It is a first report that a maintainer can understand,
share, and use to decide whether a seven-day non-blocking observation pilot is worthwhile.

Use the same call to action across npm, GitHub Marketplace, Context7, MCP directories, GitHub, and
community posts:

> Try DiffCI locally with `npx "@diffci.com/diffci@latest" check`. It analyzes the current change, runs
> inferred full and selected commands when safe, writes reports outside the checkout, and sends nothing
> by default. Existing CI remains authoritative.

Route maintainers who have already run it to the
[`Share a first DiffCI report`](../.github/ISSUE_TEMPLATE/first-diffci-report.yml) issue template.

## Adoption definitions

Count independently owned repositories, excluding DiffCI-owned repositories, internal dogfood runs,
and benchmark-only sandbox replays. Deduplicate by repository; retain the evidence link and date.

| Metric | Evidence required |
| --- | --- |
| First successful report | Maintainer-shared completed analysis or verification receipt. Record selective and full-fallback results separately; refusals/errors are attempts, not activation. |
| Recurring installation | Maintainer-approved installation plus executions on at least two distinct days within seven days. A merged PR alone is an installation milestone. |
| Known active repositories | Distinct independent repositories with an evidenced completed execution in the trailing seven days, through public workflow activity or consenting pilot reports. Report observation and verification separately. |
| Four-week retention | Activated repositories with an evidenced completed execution in days 22–28 after activation, divided by activated repositories whose full 28-day window has elapsed. Report numerator and denominator. |
| Measured net runtime savings | Comparable full/selected runs including analysis overhead, with checkout identity, command coverage, exit codes, cache conditions, and repeated timings recorded. Include zero/negative results; do not infer runtime from selection counts. |
| External contributors | Distinct independent people with an accepted code, fixture, documentation, or reproducible benchmark contribution during the reporting period. |

Maintain one weekly row per consenting pilot or publicly evidenced repository in the canonical
[DiffCI Outreach Tracker](https://docs.google.com/spreadsheets/d/1TvZo9YnDawOLR75WTyPSAf95vQ5VdoBx6iBeqJF_d60/edit):
repository, acquisition channel, first attempt/report dates, outcome, installation evidence,
latest execution evidence/date, observation or verification, retention eligibility/result,
runtime evidence, blocker, and next action. Use consented identifiers for private pilots.
Unknown activity stays unknown; do not interpret unavailable evidence as confirmed inactivity.

Known active repositories is a lower bound on evidenced usage, not total active repositories.
Current anonymous opt-in events cannot establish unique repositories or retention.

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
- npm weekly downloads: `curl "https://api.npmjs.org/downloads/point/last-week/%40diffci.com%2Fdiffci"`
- MCP binary presence: `npm view "@diffci.com/diffci" bin --json`

## Repository

- GitHub stars, forks, watchers, and release views.
- Issues or PRs opened by users asking about `diffci check`, `diffci init`, or `diffci-mcp`.
- External PRs merged that mention DiffCI agent validation.

## Site

- Visits to `https://diffci.com/docs/ai-agents`.
- Visits to `https://diffci.com/llms.txt`.
- Clicks from the homepage agent and MCP links.
- Referrers from MCP directories, awesome lists, and agent-template repositories.

## Outreach

Record each submission in `docs/agent-adoption-targets.md` or a dated note. For directory listings,
track conversion signals, not only application status:

| Channel | Status | Primary CTA | Signal to watch | Next action |
| --- | --- | --- | --- | --- |
| npm | Live | `npx "@diffci.com/diffci@latest" check` | Weekly downloads, package-page visits, first-report issues | Keep README first-run copy current. |
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

1. Review first reports, recurring installations, known active repositories, mature four-week
   retention cohorts, measured savings, and external contributions. Record evidence and denominators.
   Review downloads, traffic, directory listings, and anonymous usage separately as discovery signals.
2. Label first-run reports with `first-report` and record whether they are selective, full fallback,
   refused, or errored.
3. Reply to every first-report issue with one next step: inspect fallback/refusal, repeat with controlled
   cache state, open a non-blocking Action PR, or stop because the repo is unsupported.
4. Move strong candidates into a maintainer review packet and ask for a seven-day pilot.
5. Stop adding new directories unless an existing channel produces reports or maintainer conversations.

## Baseline snapshot — 2026-09-25

This snapshot separates distribution activity from verified adoption. npm and GitHub traffic counts
can include DiffCI's own CI, release automation, crawlers, and repeated activity by the same person.
They are supporting signals only.

| Signal | Value | Interpretation |
| --- | ---: | --- |
| npm latest version | `0.3.5` | Current CLI and MCP binaries are publicly available. |
| npm downloads, last complete registry week (`2026-09-15`–`2026-09-21`) | 1,929 | Distribution activity; not unique users or repositories. |
| GitHub stars / forks / watchers | 0 / 0 / 0 | No repository-level community conversion yet. |
| GitHub views, available 14-day window | 18 views / 4 unique visitors | Early discovery signal. |
| GitHub clones, available 14-day window | 1,088 clones / 226 unique cloners | Likely includes automation; not adoption proof. |
| External GitHub code references to the npm CLI, Action, or MCP binary | 0 found | No independently verifiable installation yet. |
| Outreach proposals | 4 open / 0 maintainer replies | Follow up once, then prioritize a maintainer who supplies a first report. |
| Opted-in `cli_usage_opt_in` executions | Not verified | Restore PostHog query access before the next weekly review. Count executions, not users. |
| Independently owned first reports or pilots | 0 verified | Primary conversion target. |

The next adoption milestone is one independently owned repository that shares a first report or
completes a non-blocking observation pilot. Do not claim user or repository counts from downloads,
clones, or opted-in executions.

## Agent-verification checkpoint — 2026-10-02

The stable 0.3.0 release gate uses two real repository integrations rather than three. DiffCI.com and
DentalPresence.in both completed the install-to-verification path and passed their remote verification
workflows. This is product-integration evidence, not independent adoption: both repositories are
maintainer-owned, and the independently owned pilot count remains zero.

Existing outreach log:

| Date | Target | Type | Link | Status | Follow-up |
| --- | --- | --- | --- | --- | --- |
| 2026-09-22 | agentsmd/agents.md | Issue | https://github.com/agentsmd/agents.md/issues/245 | Open; no reply as of 2026-09-25 | Follow up once on 2026-09-30; offer a PR only if invited. |
| 2026-09-22 | FerroxLabs/agents-md | Issue | https://github.com/FerroxLabs/agents-md/issues/2 | Open; no reply as of 2026-09-25 | Follow up once on 2026-09-30; offer a PR only if invited. |
| 2026-09-22 | ciembor/agent-rules-books | Issue | https://github.com/ciembor/agent-rules-books/issues/8 | Open; no reply as of 2026-09-25 | Follow up once on 2026-09-30; offer a PR only if invited. |
| 2026-09-22 | jbarbier/CLAUDE.md | Issue | https://github.com/jbarbier/CLAUDE.md/issues/12 | Open; no reply as of 2026-09-25 | Follow up once on 2026-09-30; offer a PR only if invited. |
| 2026-09-22 | Official MCP Registry | Directory | `io.github.adityankale190895/diffci` | Published | Consider moving to `io.github.DiffCI/diffci` after GitHub org namespace authorization is available. |
| 2026-09-25 | Official MCP Registry | Directory | `io.github.DiffCI/diffci` | Published | Organization namespace authorized through GitHub OIDC; the listing uses the versioned `https://diffci.com/mcp/v1` remote. |
| 2026-09-22 | Glama | Directory | TBD | Planned | Submit repository URL. |
| 2026-09-22 | Smithery | Directory | TBD | Blocked | Needs Smithery account/API key. |

Use independently evidenced subsequent executions and retention as the primary adoption signals.
Merged installation PRs are installation milestones; accepted directory listings are distribution
milestones. Stars, downloads, and page views support discovery analysis and do not prove usage.
