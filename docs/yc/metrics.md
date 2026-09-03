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
through `setup_url` back to `/welcome`. **2026-09-04 update: `setup_url` is now configured** - founder
signed into the real App settings page (`https://github.com/settings/apps/diffci-shadow`, sudo-mode
passkey re-auth required and completed by the founder), set it to `https://diffci.com/welcome`, saved
("Your GitHub App has been updated"), confirmed live in the field itself. The actual redirect - a real
install click landing on `/welcome` - is still not separately click-tested, since that would mean
triggering a real install/reinstall on an account; the field being set and pointing at a real, live page
is the verification this session can honestly claim.

**Remaining founder-only actions** (none silently started, all explicitly gated by the plan or by
prior instruction):
1. ~~Point `diffci.com` DNS at the deployed `diffci-site` Worker~~ - **done 2026-09-04**, founder cleared
   the pre-existing blocking DNS record, custom domain attached, verified live (see above).
2. ~~Configure `setup_url` on the live App's GitHub settings page~~ - **done 2026-09-04** (see above).
3. Publish the App listing on GitHub Marketplace. Investigated 2026-09-04 and found this is NOT a
   simple visibility toggle: raw installability ("Any account" can install) was already set at
   creation and is confirmed working today via the direct link
   (`https://github.com/apps/diffci-shadow`) - a stranger genuinely can install without talking to
   anyone, right now. "Publish the listing" specifically means GitHub Marketplace: create a draft,
   fill in a full submission (categories, support info, a pricing plan even for a free app), then
   submit for GitHub's own review and approval before it becomes searchable there. Founder chose to
   **skip this for now** rather than start the draft - the submission form is exactly where the still-
   open legal entity/contact TODO (item 4 below) would need to go in for real, and it starts a
   third-party review process that isn't trivially reversible once submitted. Not a technical blocker
   to installation; only affects discoverability via GitHub's own Marketplace search.
4. Legal entity / jurisdiction / contact address - pre-existing `[TODO before launch]` on every site
   page footer, untouched this session, **now live and publicly visible** as of the DNS change, and
   the concrete blocker on item 3 above.
5. ~~Complete the uninstall-triggered data-deletion pipeline~~ - **done 2026-09-04** (commit `56fc205`).
   `src/research/cloudflare/shadow-erasure.ts` implements both commitments
   `site/data-handling.html` makes: `installation.deleted` now triggers real erasure (D1 rows +
   R2 evidence archives) for every attributed repository, fire-and-forget from the webhook handler; a
   90-day retention sweep runs every cron tick (~10 min), keyed off `prediction_created_at` - a real
   bug (filtering by insert-time `created_at` instead) was caught by a new SQLite-backed test before it
   shipped. 1960/1960 tests pass. The page's "do not launch this page yet" banner is replaced with an
   honest status note; deployed and verified live at `https://diffci.com/data-handling`. The one
   remaining manual piece was never a different promise: an ad-hoc "delete my data now, without
   uninstalling" request still goes through a person, not a self-service form.

**Own-repo installs confirmed live, 2026-09-04.** Before outreach, founder asked to confirm the App is
actually receiving events on our own two repos, not just installed. Checked directly:
- `adityankale190895/DiffCI.com` and `adityankale190895/DentalPresence.in` are both, right now, the
  App's only two repository-access selections (`github.com/settings/installations/155368612`,
  "Only select repositories", installed 2 weeks ago) - confirmed live in the GitHub UI, not assumed
  from D1.
- **DiffCI.com**: drilled into GitHub's own webhook delivery log (`/v1/shadow/app-info?delivery=<id>`,
  the App's real deliveries, not our own logs) for 4 of the last 15 deliveries - all
  `requestRepository: "adityankale190895/DiffCI.com"`, all within the last hour, correctly triggering
  `poll-scheduled`/`reconcile-scheduled`. 297 predictions, 65 reconciled ground-truth rows; the latest
  prediction's engine commit (`56fc205`) matches this session's own deploy exactly.
- **DentalPresence.in**: 20 predictions, 18 reconciled ground-truth rows; its live shadow report shows
  18 of 20 eligible commits observed in the last 14 days, through today. This can only come from real
  webhook deliveries - it's enrolled `observation_source = 'github-app-webhook'`, which the separate
  polling-cron path explicitly excludes (`listPollableRepositories()` only pulls `cloudflare-poll`
  repos), so there is no other mechanism that could have produced these rows. It didn't appear in the
  same 15-item recent-deliveries sample as DiffCI.com only because that sample is capped app-wide and
  all of today's push/CI activity happened to land on DiffCI.com.

**Blocker assessment for outreach beginning 2026-09-11:** none. The technical front door - domain,
install flow (including `setup_url`), welcome page, hosted report, and real erasure - is fully live and
matches what `site/data-handling.html` promises; a stranger can already install via the direct link
today; and the App's install on both of our own repositories is confirmed actually receiving and
processing real events, not merely present. What's left (items 3-4 above) is a deliberate founder
decision (Marketplace listing deferred until legal identity is settled), not a build gap.

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

## Launch-readiness audit, 2026-09-03 (R1 final check before founder go)

Audited diffci.com as a first-time technical maintainer, every quantitative claim against
`docs/website/03-evidence-ledger.md`, plus live HTTP behaviour, metadata, mobile layout, console/network
errors, and the install → welcome → report chain. **Verdict: NOT READY, for founder-only reasons; every
build-owned blocker was fixed and redeployed in the same session.**

**Fixed and deployed (build-owned):**
- Removed the stale "Not ready to launch" box that was live on the homepage and contradicted the
  data-handling page (it claimed the deletion path was unimplemented).
- Replaced the literal `[TODO before launch: legal entity, jurisdiction, contact address.]` footer on all
  seven pages, and the data-handling Contact section, with honest text: ships under the founder's
  personal GitHub account; company identity and contact address not yet published. No mailbox invented.
- Hero: added the primary "Install the read-only App" CTA (it existed only at the bottom of the page, and
  the masthead nav is hidden on phones, so mobile visitors had no visible CTA above ~7,000px).
- Hero stats "6 merges" and "8 of 8 honored" were cal.com-only figures shown without scope and had no
  ledger row; replaced with the cross-repository truth (10 merges, 12 of 13 honored, 13th withheld) and
  added ledger rows for them, the chart timings, and the "44% and 90%" sentence.
- "one test file selected ... in both" was wrong for cal.com PR #29940 (2 of 406, Report 10); corrected.
- "The external pilot is early" implied an external pilot exists; replaced with "There is no external
  pilot yet" (zero external installs, re-confirmed).
- Homepage promised an ineligible repository's report "will say so"; the report does not yet explain
  why it is empty. Reworded to say exactly that.
- Own-CI figures re-measured today (`scripts/remeasure-own-ci-cost.ts`, `npm test`): $0.0048–$0.0127/job
  (median $0.0053), 135–354s wall, 1,960 tests / 389 suites. Propagated to site, ledger, CURRENT_STATE,
  drafts. Also resolved a $0.0044-vs-$0.0045 transcription mismatch between the ledger and every copy.
- Added a neutral "Isn't this just Nx affected / Turborepo / a path rule?" section using only the
  already-approved positioning (different question; explicitly no cost-superiority claim, R5 open).
- Welcome page now states plainly that DiffCI has no email address for the installer and will send
  nothing on day 7; the report URL is the only delivery channel.
- Open Graph / Twitter / canonical metadata on every page; `favicon.ico` (was 404); `_headers` with
  nosniff / referrer-policy / frame-deny. App manifest `setup_url` updated to match the live App.

**Founder-only before public launch (priority order):**
1. Contact route. The repo is private and the GitHub profile has no name, blog, or email, so a stranger
   currently has no way to reach anyone — for deletion requests, security reports, or questions. Needs a
   mailbox on diffci.com (or a deliberate decision to publish an existing address), then one line each in
   the footer and `site/data-handling.html`.
2. Enforce HTTPS: `http://diffci.com/` serves the page in cleartext without redirecting. Cloudflare zone
   setting "Always Use HTTPS" (dashboard); optionally HSTS after that.
3. `www.diffci.com` returns Cloudflare 522 (a proxied record pointing nowhere). Either add a www custom
   domain route / redirect or delete the record.
4. Founder/company identity line in the footer (name, entity if any, jurisdiction) — copy is ready to
   receive it; nothing was invented in the meantime.

**Before outreach (in addition):** a reply-to address for the outreach messages themselves; decide
whether day-7 report delivery stays pull-only (URL) or gets an email step once a mailbox exists.

**Can wait:** GitHub Marketplace listing (already deferred by decision); a diffci.com hostname for the
report route (currently a workers.dev URL on the welcome page); og:image; cosmetic empty cell in the
3-stat hero grid on phones.
