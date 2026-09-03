# YC readiness plan — W27 application

**Written:** 2026-09-03 · **Status:** proposed, not started, uncommitted
· **Target:** Y Combinator Winter 2027 batch, application deadline **2026-11-02 20:00 PT**
(2026-11-03 09:30 IST), decisions by 2026-12-11. Late applications are read but not on a schedule.
· **Runway to deadline:** 60 days, planned as 8 working weeks with a 2-day submission buffer.

This document is the operating plan. Progress is tracked in [`metrics.md`](metrics.md), one row per
week. Nothing here is a research protocol; there are no preregistrations in this workstream. The
governing rule is stated once and applies to every week:

> **Founder time goes to humans. Build time goes to code. Engine research is stopped unless a paying
> or pilot repository is blocked by it.**

The engine is frozen at `c65da56` for the duration except for demand-driven fixes (see §4).

---

## 1. What "YC-ready" means, measurably

YC scores founders, market, product, and traction. As of 2026-09-03 DiffCI is strong on product depth
and insight, and has **zero external users, zero revenue, zero outreach, and an unpublished website**.
The gap is distribution, not code. Readiness is defined as all seven of these being true on
2026-10-30:

| # | Criterion | Today | Target |
|---|---|---|---|
| R1 | diffci.com is live: homepage, evidence page, three case studies, one-click read-only App install | drafts in `docs/website/` | live, every number ledger-backed |
| R2 | External repositories in shadow mode, each receiving a weekly report a human maintainer has read | 0 | **≥ 10 installed, ≥ 5 with a maintainer reply** |
| R3 | Repositories where DiffCI actually skipped work in real CI and a **Validated** (executed and timed) saving was recorded | 0, nothing ever skipped anywhere | **≥ 1 external** (plus DiffCI's own CI) |
| R4 | Design partners on record about money: paying, signed letter of intent, or a written "would pay $X" | 0 | **≥ 3** |
| R5 | A measured answer to "why not Nx affected / Turborepo / a path rule" | hono: DiffCI loses to a path rule on 18/22 | either ≥ 2 pilot repos where incremental CPU is positive, or the evidence-layer reframe adopted and stated |
| R6 | Team story settled: cofounder decision, DentalPresence time allocation | undecided | decided by 2026-09-30 |
| R7 | Application, 1-minute founder video, 2-minute product demo, reviewed by two people who have been through YC | none | submitted by 2026-10-30 |

If R2 and R3 are met, the application is competitive. If only R1 is met, it is a well-written
rejection. R3 is the single item that converts "research project" into "product".

---

## 2. Timeline

Dates are inclusive. Each week has an owner split: **F** = founder (humans, decisions, outreach),
**B** = build (Claude Code sessions, code and copy).

### Week 1 · Sep 4–10 · Ship the front door

| Owner | Task | Done when |
|---|---|---|
| B | Build and deploy diffci.com from the `docs/website/` drafts on Cloudflare Pages, using the earmarked enterprise domain slot | Site renders; every number on it has a ledger row |
| B | Re-measure the two stale ledger rows (CI cost per job, CI wall time, both "as of 2026-08-21") | Ledger updated with 2026-09 figures |
| B | Make the Shadow App installable by strangers: public listing, install URL on the site, post-install landing page that says what happens next and when the first report arrives | A stranger can install without talking to anyone |
| B | Hosted per-repository shadow report page on the Worker, using the existing `renderShadowReport` vocabulary rules; report link emailed to the installer on day 7 | Report reachable by URL; no "saved" wording anywhere |
| F | **Authorize outreach** (standing memory says none is authorized). Decide channel order for week 2. | Written go/no-go in `metrics.md` |
| F | Write the ideal-customer profile in one paragraph. Recommendation: TypeScript or JS monorepo, GitHub Actions, CI ≥ 15 min, ≥ 50 PRs/month, test stage dominates install stage. cal.com and deepseek-harness are the reference shapes. **Not** small npm libraries (the pilot corpus of lodash/chalk/rimraf is the wrong customer; those repos have nothing to save). | ICP paragraph in `metrics.md` |

Site publication is outward-facing and needs the founder's explicit go before DNS is pointed.

### Week 2 · Sep 11–17 · Outreach wave 1

| Owner | Task | Done when |
|---|---|---|
| F | Build a list of 60 target repositories matching the ICP: GitHub search for `turbo.json` / `nx.json` / `pnpm-workspace.yaml` with long-running `ci.yml`, plus personal network and Indian startups with public repos | 60 rows: repo, maintainer, CI minutes, contact route |
| F | Send 50 personalized messages. The ask is small and true: read-only install, seven days, you get a measured report of what your CI is spending on unaffected work, nothing in your pipeline changes. | 50 sent, logged |
| F | Book 10 thirty-minute maintainer interviews. Questions: how long is CI, what does it cost, who feels it, what would you pay, what would make you let a tool skip anything. | 10 booked |
| B | Onboard every install within 24 hours. Log every engine outcome (REPRODUCED / REFUSED / DIVERGED) per pilot repo in `metrics.md`. | Zero installs waiting more than a day |
| B | Add the incremental-economics comparator (the hono CPU meter) to the shadow report so every pilot repo produces a "DiffCI vs path rule" number automatically | Number appears on every report |

Target by end of week 2: **5 installs**.

### Weeks 3–4 · Sep 18–Oct 1 · Pilot operations and the economics answer

| Owner | Task | Done when |
|---|---|---|
| F | Run the 10 interviews. Record verbatim answers to "what would you pay". | 10 transcripts summarized in `metrics.md` |
| F | Outreach wave 2 (another 50) if installs are under 8 by Sep 24 | Sent and logged |
| F | Ask every engaged maintainer one question: "If the report shows X, would you let DiffCI run the selected subset on one job?" Collect the yes list; that is the R3 candidate pool. | Yes list has ≥ 2 names |
| B | Deliver every day-7 report on time. Reports are the product; treat a late report as a P0. | 100% on time |
| B | **Demand-driven engine fixes only.** ENGINE_COVERAGE_01 items 2–4 (TEST-purpose recognition, container parity, parser coverage) are done only when a fix unblocks ≥ 2 pilot repositories. Same for any new refusal class. Regression corpus stays as is. | Each fix names the pilot repos it unblocked |
| B | Compute incremental CPU vs the path-rule comparator on every pilot repo. Working hypothesis: multi-package graphs with large test-to-install ratios are where DiffCI wins; hono (single package, fast tests) is the worst case. | R5 table filled: repo, incremental sign, magnitude |
| F | **Decide R5 by Oct 1.** If ≥ 2 repos are positive, the pitch is "cheaper than Nx affected, with proof". If not, the pitch is the evidence layer on top of whatever selector they already use, which `docs/website/01-positioning.md` already argues. Do not carry both. | One sentence written in `metrics.md` |
| F | **Decide R6 by Sep 30.** Recommendation: apply solo, state it plainly, keep looking. A cofounder added in October reads as "met last month" and is weaker than a clear solo story. DentalPresence: maintenance only through Dec 11, stated as such. | Decision in `metrics.md` |

Target by Oct 1: **10 installs, 5 reports read, 2 activation candidates.**

### Weeks 5–6 · Oct 2–15 · Activation, first on ourselves, then on one partner

This is R3 and it is the fortnight that matters most.

| Owner | Task | Done when |
|---|---|---|
| B | Build the smallest honest activation mechanism: a GitHub Action step that calls the Worker, receives the selection or a `RUN_FULL` verdict from `activation-gate.ts`, and exports it as a test filter the repo's own workflow consumes. Fallback to full on any error, any refusal, any `RUN_FULL_SUITE`. The customer edits one workflow file, by their own hand, once. | Step published; DiffCI's own CI uses it |
| B | Dogfood on DiffCI.com's own CI for one week. Record full-run baseline (last 20 runs) vs selected-run timings in the real CI, not a replay. This is the first **Validated-in-production** row in the ledger. | Ledger row with evidence level Validated |
| F | Get one external partner from the yes list to turn it on for one job. Offer: free, we watch every run, you can revert in one line. | One external repo activated |
| B | Measure the partner's real CI before/after for ≥ 5 runs. Record as Validated. If the number is small or negative, record that too; an honest small number beats a withheld one. | Ledger row |
| F | Put a price in front of three maintainers. Two options to test: flat $99–499/month per repo by CI volume, or a share of Billable validated savings. Ask for a signed design-partner letter. | R4: 3 on record |

If no partner agrees by Oct 10, proceed with dogfood activation as R3 and say so in the application.

### Week 7 · Oct 16–22 · Application

| Owner | Task | Done when |
|---|---|---|
| F | Write the application. Draft answers are in §3. Numbers come from `metrics.md` only. | Draft complete |
| F | Film the 1-minute founder video: who you are, what DiffCI does in one sentence, the one measured number, why you. Plain, no slides. | Uploaded |
| B | Build the 2-minute product demo: install → day-7 report → activation on one job → the measured saving. Real repos, real numbers, no mock data. | Recorded |
| F | Send the draft to two YC alumni or founders for review. Ask them to be brutal about traction framing. | Two written reviews |

### Week 8 · Oct 23–Nov 1 · Submit

| Owner | Task | Done when |
|---|---|---|
| F | Take the final metrics snapshot on Oct 29. | `metrics.md` final row |
| F | Incorporate reviews, submit **by Oct 30**. Do not use the buffer. | Submitted |
| B | Keep every pilot report on time. Traction should keep moving between submission and interview. | Weekly reports continue |

---

## 3. Application narrative, drafted now so the sprint aims at it

**One line.** DiffCI measures how much of your CI is spent re-running work your change could not have
affected, then proves each skip was safe before it ever touches your pipeline.

**What is impressive.** Everything is measured, nothing is estimated where it can be executed instead.
The engine abstains rather than guesses. The CI for the product itself runs on self-hosted Cloudflare
containers at about $0.004 per job. One founder, 1,929 tests, 413 commits, and an evidence ledger
where the unflattering numbers stay in.

**Why now.** AI-assisted coding is multiplying PR volume. Every extra PR runs the full CI matrix. CI
compute and wall time are becoming the bottleneck on how fast a team can merge, and nobody trusts a
tool to skip tests without proof. DiffCI is the proof.

**Why not Nx affected / Turborepo / Launchable / Datadog ITR.** Filled from R5. Either "we measured,
and on repos shaped like yours we beat a path rule after paying for our own analysis" or "those tell
you what to run; we tell you whether it was safe and what it was worth, reconciled against what CI
actually did afterwards".

**Traction.** Filled from `metrics.md`: installs, reports read, activated repos, validated savings,
design partners, and the growth curve across the eight weeks.

**Team.** Filled from R6. The honest version: solo technical founder building with AI tooling, second
business in maintenance mode, looking for a cofounder with developer-tools go-to-market experience.

---

## 4. What stops, and what is only done on demand

| Item | Status during this plan |
|---|---|
| ENGINE_COVERAGE_01 items 2–4 | On demand only: a fix must name ≥ 2 pilot repos it unblocks |
| Addressability survey (rank 23 holdout, ranks 1–40 frame) | Paused. Its subjects are npm libraries, which are not the customer. Resume only if there is slack after R2 is met. |
| New preregistration or research-report documents | None. The weekly `metrics.md` row replaces them. |
| Mechanism-line work (MI-03, generation D/E) | Remains closed per 2026-09-01 decision |
| Internal replay validation | Remains closed per 2026-08-25 decision |
| Regression corpus (rimraf, lodash, husky, chalk, eslint) | Frozen. Run before any deploy. Not extended. |

---

## 5. Risks and the rule for each

| Risk | Trigger | Response |
|---|---|---|
| Nobody installs | < 5 installs by Sep 24 | Distribution problem, not product. Switch channel: Show HN post with the evidence page, dev Discords, direct DMs to maintainers of the 60-repo list. Do not build. |
| Engine refuses most pilot repos | > 50% of installs REFUSED | Coverage becomes the week-3 build priority, still ranked by pilot repos unblocked per fix |
| Economics negative everywhere | 0 repos with positive incremental CPU by Oct 1 | Adopt the evidence-layer reframe (R5 option 2) and stop claiming cost superiority |
| No activation partner | None by Oct 10 | Apply with dogfood activation as R3, state it as such |
| Founder time drains to DentalPresence | Any week where outreach quota is missed | Cut DentalPresence to emergencies only through Dec 11 |
| Rushed cofounder | Anyone considered after Sep 30 | Apply solo |
| A number on the site or in the application without a ledger row | Any | It does not ship. The credibility of every other number depends on this. |

---

## 6. Decisions that are the founder's, not the build's

These are outward-facing or irreversible and are not taken in a build session without an explicit go:

1. Pointing DNS at the site (week 1)
2. Any outreach message to any maintainer (week 2 onward)
3. Publishing the App listing publicly (week 1)
4. Any activation in a third-party repository (week 6)
5. Any price quoted to anyone (week 6)
6. Submitting the application (week 8)
