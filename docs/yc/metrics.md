# YC sprint metrics

One row per week. Numbers only from things that happened. Blank means not measured, never zero.

| Week ending | Installs (cum.) | Active repos | Reports delivered | Reports read (reply) | Interviews done | "Would pay" on record | Activated repos | Validated savings (ledger rows) | Outreach sent | Notes |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 2026-09-03 (baseline) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | Plan written. Engine frozen at c65da56. Re-verified 2026-09-03 (post-build): 0 genuine external (github-app-webhook) installs exist in diffci-research - confirmed by direct D1 query, not assumed. 8 repos enrolled via cloudflare-poll are the pre-existing internal research corpus (unconsented REST polling for validation work), not pilots; 2 github-app-webhook repos are DiffCI's own (DiffCI.com, DentalPresence.in), not external. Incremental-economics comparator built and deployed (commit 1445ae4, both diffci-research-sandbox and diffci-product redeployed, D1 migration applied+backfilled against real data). See "Dashboard, 2026-09-03" and "Single largest obstacle" below. |
| 2026-09-10 | | | | | | | | | | |
| 2026-09-17 | | | | | | | | | | |
| 2026-09-24 | | | | | | | | | | |
| 2026-10-01 | | | | | | | | | | R5 and R6 decisions due |
| 2026-10-08 | | | | | | | | | | |
| 2026-10-15 | | | | | | | | | | |
| 2026-10-22 | | | | | | | | | | |
| 2026-10-29 | | | | | | | | | | Final snapshot; submit Oct 30 |

## Decisions log

| Date | Decision | By |
|---|---|---|
| | Outreach authorized: yes / no | founder |
| | Ideal-customer profile (one paragraph) | founder |
| | R5: cost-superiority pitch vs evidence-layer pitch | founder |
| | R6: cofounder and DentalPresence allocation | founder |

## Pilot repositories

| Repo | Installed | First engine outcome | Report day-7 sent | Maintainer replied | Incremental CPU sign | Activation candidate |
|---|---|---|---|---|---|---|

## Dashboard, 2026-09-03 (build-side check-in, not a weekly row)

Every number below is from a direct, real check today (D1 queries against `diffci-research`, Worker
health endpoints) - none are carried forward from the plan's own baseline row without re-verifying.

| Metric | Value | Source |
|---|---:|---|
| Outreach sent | not visible from here | founder-owned, per the plan; not tracked in any system this session can query |
| Installs (genuine, `github-app-webhook`, external) | **0** | `SELECT observation_source, COUNT(*) FROM shadow_repositories` - real D1 query |
| Reports pending | 0 | no pilot exists to owe a report to |
| Reports delivered | 0 | `renderShadowReport` is not yet wired to any live Worker route - see obstacle below |
| Maintainer replies | 0 | no pilot exists |
| REPRODUCED / REFUSED / DIVERGED (pilot repos) | 0 / 0 / 0 | no pilot exists; unrelated to the closed `ENGINE_COVERAGE_01` engine-research corpus |
| Positive incremental-economics repos | 0 of 0 | comparator now built and deployed; the 8 research-corpus repos it can already compute against are not pilots and are not reported here as if they were |
| Activation candidates | 0 | R3's "yes list" does not exist yet |

## Single largest obstacle to reaching 10 installed repositories

**There is currently no live install funnel to convert a "yes" into an install at all.** Checked
directly, not assumed:

- `renderShadowReport`/`rollUpShadowReport` are not imported by either deployed Worker
  (`diffci-research-sandbox`, `diffci-product`) - only by unit tests and the standalone,
  locally-run `scripts/generate-shadow-report.ts`. There is no URL a maintainer could visit, and no
  mechanism to email one on day 7.
- The Shadow App has no public listing and no install link on a live site (`docs/website/` is still
  drafts; DNS is not pointed - both explicitly gated on the founder's go, per the plan's own §6).
- Even a maintainer who somehow found and used the App's raw GitHub install page today would land
  nowhere afterward - no post-install landing page exists to tell them what happens next or when to
  expect a report.

This is a **process/infrastructure gap, not an engine or outreach gap** - the underlying engine and
data pipeline (poll, capture, economics) are real and working, confirmed by the 8 already-enrolled
research-corpus repositories producing real observations today. The blocker is that Week 1's three
build tasks (site + one-click install, App public listing, hosted report page + delivery) are the
plan's own explicit prerequisites for Week 2's "convert every yes into a pilot" mandate, and none of
the three exist yet. Outreach converting a maintainer to "yes" right now would have nowhere to send
them.

**Not built in this session, and not silently started**: the hosted report page, its routing/access
control, and email delivery are Week 1's own scoped deliverables, distinct from the comparator this
session was asked to build. Flagged here rather than expanded into without being asked, given their
outward-facing nature (a public URL, a public App listing) is explicitly gated on the founder's go
per the plan's own §6.
