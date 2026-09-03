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

## Week 1 close-out, 2026-09-03/04 ("SHIP THE FRONT DOOR")

Everything below is what actually shipped and was actually verified live this session - not a status
claim carried forward. Commits: `a4ee705` (re-measurement), `1445ae4` (comparator, Week 2 - already
landed before Week 1 began), `4648495` (hosted report route), `7dee8a6` (welcome page + site fixes +
manifest), `fa7e216` (day-7 founder diagnostic), `130bd6c` (diffci.com custom domain route).

**2026-09-04 update - diffci.com is live.** Founder-authorized and completed: the zone's pre-existing
externally-managed DNS record at the apex (blocking the custom-domain attach, error 100117) was cleared
by the founder; `npm run site:deploy` then attached the custom domain cleanly. Verified directly:
`https://diffci.com/` returns 200 with the real homepage title, `/welcome`, `/case-studies/diffci-own-ci`,
and `/data-handling` all resolve 200, unknown paths correctly 404, and the `workers.dev` fallback URL
still works. **R1's "diffci.com is live" is now substantively true** - the one open piece is the App's
public Marketplace listing, still `public: false` and correctly gated per the plan's own SS6 (a separate,
still-untaken founder decision from pointing DNS).

**Shipped and verified live:**

- `GET /v1/shadow/report?repository=<owner/name>&days=<n>` - public, no auth, deployed to
  `diffci-research-sandbox`. Verified live against a real populated repo
  (`adityankale190895/DiffCI.com`, real MEASURED/ESTIMATED-labeled output) and a real unenrolled repo
  (`nobody/nowhere`, honest "no completed CI workload was observed" - no fabricated numbers).
- `site/welcome.html` - post-install landing page, deployed to `diffci-site`, live at
  `https://diffci-site.damp-waterfall-0cd8.workers.dev/welcome`. Explains the 5 read-only
  permissions, the 7-day timeline, links a report-lookup form directly to the route above, and links
  `/data-handling`.
- Two stale metrics re-measured with real, reproducible provenance (`scripts/remeasure-own-ci-cost.ts`,
  real `gh api` job timings, real Cloudflare Containers `standard-2` pricing): CI cost per job now
  $0.0045-$0.0116/job (median $0.0052); CI wall time now 126s-325s (median 146s). Propagated to the
  evidence ledger, `CURRENT_STATE.md`, homepage copy, and the live site HTML - all previously-stale
  `$0.004` / `1,357 tests` / "about a minute" figures corrected everywhere they appeared.
  Old vs. new is a suite-size difference (286 -> 384 suites, ~4x growth), not a regression.
- `GET /v1/shadow/day7-status` - bearer-gated founder diagnostic, deployed and verified live: returns
  the real enrolled-repository list with computed days-since-enrollment and a 7-day-readiness flag.
  Confirms the same fact the dashboard below reports: 2 `github-app-webhook` repos, both DiffCI's own.
- Incremental-economics comparator (Week 2 work, already live) unaffected and still deployed.

**Verified end-to-end (item 8), precisely:** landing page (`/`) -> install link (real, points at
`github.com/apps/diffci-shadow`) -> welcome page (`/welcome`, live) -> report lookup form -> hosted
report route (live, real data for an enrolled repo, honest empty-state for an unenrolled one). The one
link in this chain that could **not** be verified this session: the GitHub install flow's own redirect
through `setup_url` back to `/welcome`, because `setup_url` is a GitHub-UI-only field on the App's
settings page (not settable via the manifest API) and applying it is a founder-only action not yet
taken. The manifest file documents the intended value; the live App does not yet have it configured.

**Remaining founder-only actions** (none silently started, all explicitly gated by the plan or by
prior instruction):
1. ~~Point `diffci.com` DNS at the deployed `diffci-site` Worker~~ - **done 2026-09-04**, founder cleared
   the pre-existing blocking DNS record, custom domain attached, verified live (see above).
2. Configure `setup_url` on the live "DiffCI Shadow" App's GitHub settings page (UI-only, not yet done).
3. Publish the App listing publicly (currently `public: false`; explicitly gated per this task's own
   instruction: "STOP before publicly publishing the App listing unless explicit founder authorization
   exists").
4. Legal entity / jurisdiction / contact address - pre-existing `[TODO before launch]` on every site
   page footer, untouched this session, **now live and publicly visible** as of the DNS change.
5. Complete the uninstall-triggered data-deletion pipeline. **This is now a live, real problem, not a
   future one**: `site/data-handling.html` is publicly reachable at `https://diffci.com/data-handling`
   today (verified 200), and it still carries its own pre-existing banner - "Unfinished - do not launch
   this page yet... the automated deletion path... is not implemented yet. Until it is, this page must
   not be published." That page is now published, with its own banner contradicting that fact, at the
   real domain. I verified the underlying gap is still accurate: `shadow-webhook.ts`'s
   `installation`/`action:"deleted"` handler only logs today - it deletes nothing from D1 or R2. I did
   not build this in this session (a new `R2Binding.delete()` capability doesn't exist yet, plus
   deletion logic across 3 D1 tables) and did not remove the banner or the page - flagging it here and
   in chat instead of silently either building around it or hiding it.

**Blocker assessment for outreach beginning 2026-09-11:** the technical front door is now fully live,
including the domain. The one thing that changed status with the DNS flip: item 5 above went from
"a gap that will matter once the site is public" to "a self-contradicting page a real visitor could
land on right now." It's still not a blocker to the App install flow itself (data-handling.html is
prose, not code in the install path), but it's the most credible reason to fix or gate that one page
before outreach starts, rather than before DNS - DNS is done now.

## Dashboard, 2026-09-03 (superseded by Week 1 close-out above for infrastructure status; genuine
install counts below still current - re-verify before Week 2 reporting)

| Metric | Value | Source |
|---|---:|---|
| Outreach sent | not visible from here | founder-owned; not tracked in any system this session can query |
| Installs (genuine, `github-app-webhook`, external) | **0** | `SELECT observation_source, COUNT(*) FROM shadow_repositories` - real D1 query, re-confirmed via `/v1/shadow/day7-status` |
| Reports pending | 0 | no external pilot exists to owe a report to |
| Reports delivered | 0 | route now exists and is live (see close-out above) but has never been sent to an external maintainer |
| Maintainer replies | 0 | no pilot exists |
| REPRODUCED / REFUSED / DIVERGED (pilot repos) | 0 / 0 / 0 | no pilot exists; unrelated to the closed `ENGINE_COVERAGE_01` engine-research corpus |
| Positive incremental-economics repos | 0 of 0 external | comparator live; the research-corpus repos it can compute against are not pilots |
| Activation candidates | 0 | R3's "yes list" does not exist yet |
