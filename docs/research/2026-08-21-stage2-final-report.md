# Stage 2 final report — prospective shadow validation

Companion documents: `2026-08-21-stage2-architecture.md` (Phase 1 gap analysis, full design),
`2026-08-21-stage2-enforcement-thresholds.md` (Phase 17, committed before any results existed),
`2026-08-21-stage2-controlled-enforcement-design.md` (Phase 18, design only).

## What this session actually delivered

1. **A real, live, end-to-end prospective pipeline** - not a prototype behind a flag. Four Bearer-
   token-authorized Cloudflare Worker routes (`/v1/shadow/enroll`, `/v1/shadow/poll`,
   `/v1/shadow/reconcile`, `/v1/shadow/status`) were deployed and individually verified against real
   infrastructure: real D1 tables (migration applied, rows confirmed via direct query), real R2 evidence
   storage, and real target repositories (`unjs/defu`, `unjs/unstorage`, `unjs/h3` - chosen for size/
   activity diversity, not because DiffCI was known to perform well on them).
2. **One real, live infrastructure bug found and fixed during Gate A dispatch**: `cloneOrUpdateRepo`'s
   `--depth 0` is rejected by git outright; fixed to a bounded `POLL_CLONE_DEPTH=100`, verified live
   against all three enrolled repositories afterward.
3. **One real, pre-existing, unrelated bug found and fixed while inspecting prior shadow infrastructure**:
   every historical run of `.github/workflows/diffci-shadow.yml` (15+ checked) had failed at GitHub
   Actions startup due to an unnecessary `actions: write` permission request - fixed, though its actual
   verification was then blocked by an unrelated, real, account-wide GitHub Actions billing failure (see
   below).
4. **The full core prediction/reconciliation/safety/classification pipeline**, genuinely reusing Stage
   1B's already-validated safety methodology rather than reimplementing it, with 33 new unit tests (278/
   278 total passing) covering event identity, failure classification, reconciliation math (recall,
   hypothetical unsafe misses, the prospectiveness proof), and a real RSA sign/verify round-trip for the
   (not-yet-registered) GitHub App JWT code.
5. **Every required design document**: architecture/gap-analysis, enforcement thresholds (committed
   before results), controlled-enforcement design (Level 0-3, kill switch, rollback - design only).

## A real prediction landed during this session

While repeatedly re-polling as designed (waiting for real upstream activity, not backfilling history),
`unjs/h3` genuinely pushed two new commits, and a follow-up poll caught both automatically:
`state` correctly transitioned `VALIDATING → SHADOW_ACTIVE`. The two real, live predictions:

| head SHA | real commit | `plan_mode` | `opportunity_category` | `effective_graph_confidence` | analysis overhead |
|---|---|---|---|---|---|
| `3a57939c` | `fix(ws): keep WebSocket hooks reachable when the response is rebuilt` (touched `package.json` + `pnpm-lock.yaml` + source + a test) | FULL | MANDATORY_FALLBACK | COMPLETE | 2,646 ms |
| `b137cde2` | `chore(release): v2.0.1-rc.29` (touched `CHANGELOG.md` + `package.json`) | FULL | MANDATORY_FALLBACK | COMPLETE | 1,055 ms |

Both fell back to FULL despite a `COMPLETE` graph confidence - expected, not a bug: the first commit
touched `pnpm-lock.yaml` (the `LOCKFILE_GLOBAL` risk rule, which Stage 1B never narrowed and by design
still forces FULL on any lockfile change), and both touched `package.json` on a real release/dependency-
adjacent commit. This is exactly the `MANDATORY_FALLBACK` category behaving as designed - real evidence
the opportunity classifier is seeing genuine variety, not just tied/inert deltas. A reconciliation attempt
immediately after (`/v1/shadow/reconcile`) correctly returned `stillPending: 2` - these commits are too
fresh for their own real CI to have completed yet, and the pipeline did not fabricate a result to fill
that gap.

**Beyond this, no further real ground-truth reconciliations exist yet**, and no `DISCRIMINATIVE_OPPORTUNITY`
prediction (the category that actually exercises DiffCI's selective-skipping logic) has been observed on
any of the three repositories so far - both real h3 predictions, and the two established baselines on
`unjs/defu`/`unjs/unstorage`, are exactly the kind of real-world result the enforcement-thresholds
document anticipated needing volume to see past: this session's roughly two-and-a-half hours of real
elapsed polling was never going to reach the ≥50-run, ≥15-discriminative-opportunity floor, and it
didn't. That volume gap is reported as a gap, not filled with anything invented.

**This account's own GitHub Actions is currently billing-blocked** (real check-run annotation: "recent
account payments have failed or your spending limit needs to be increased"), which is why Gate A targets
third-party repositories via Cloudflare polling rather than this repository's own `diffci-shadow.yml`
step. This also means the originally-planned first-party validation path (this repo's own real commits,
via the now-fixed GitHub Actions workflow) could not be exercised live in this session either - it will
become available once the user resolves the billing issue, independent of anything built here.

**No GitHub App is registered**, per an explicit decision with the user (code ready, registration is the
user's action). **No real design-partner repositories were recruited** - Gates B (1 real partner), C (3
repositories), and D (5-10 repositories) all explicitly require actual external stakeholders this session
had no access to; running them with fabricated or synthetic "partners" would defeat their entire purpose.
**No dashboard/customer-facing UI, no dollar-cost economics, and no autonomous (Cron Trigger) polling**
were built - each requires either real volume that doesn't exist yet or a small, separately-scoped
follow-up (see the architecture doc's "What Stage 2 does NOT do" section for the concrete next step on
each).

## Core Stage 2 questions - answered honestly given the above

1. **Does DiffCI remain effective on prospective live CI events?** Unknown - zero real events have been
   reconciled yet. The pipeline that would answer this is built, deployed, and verified to run without
   error; it has simply not yet observed a real outcome.
2. **Does the Stage 1B wall-clock result reproduce in real ongoing workloads?** Not yet testable - no
   real reconciled events.
3-7, 9. **Compute %, wall-clock %, opportunity frequency, fallback rate, prospective recall, DiffCI vs
   PATH safety?** All unmeasured - zero denominator on every one of these. Reporting a percentage here
   would violate the task's own explicit instruction never to claim a rate from an empty denominator.
8. **Were any credible code-related unsafe misses observed?** None - and none could have been, since
   zero ground truth has been reconciled. This is different from "zero misses found after real
   observation" and is reported as such.
10. **Is analysis available early enough to sit on a future CI critical path?** Partially answerable from
    infrastructure timing alone: the real Gate A poll dispatches (container clone + real TS dependency-
    graph analysis for a small/medium repo) completed within the route's 200s client timeout every time,
    typically well under it - suggestive that the analysis itself is fast enough, but this is not the
    same as measuring real end-to-end prediction latency against a live webhook-triggered event, which
    doesn't exist yet (Phase 21's `predictionLatency`/`predictionReadyBeforeCIStarted` metrics need a real
    triggered-by-event timestamp to compare against, not just a manual dispatch).
11-13. **Operating cost, cost ratio, absolute savings?** Unmeasured - no real volume.
14-16. **Which profiles benefit most/least? Do large repos behave better post-Stage-1?** Unanswerable
    from Gate A alone even with real data - three repositories is not enough to characterize "profiles,"
    and this question needs Gate B/C/D's deliberately diverse partner set, not more polls of the same
    three unjs-ecosystem repositories.
17. **Which CI job categories dominate remaining cost?** Unmeasured.
18. **Should DiffCI proceed to controlled enforcement?** No - see the decision below.

## Stage 2 decision

**EXTEND SHADOW VALIDATION.**

Not `GO`, because there is no real prospective evidence yet to base a go decision on - the enforcement-
thresholds document's volume floor (≥50 reconciled runs, ≥15 discriminative opportunities, ≥5 evaluable
failures, ≥14 days) is nowhere close to met, and it would be a direct violation of this task's own
"Research integrity" instructions to claim otherwise. Not `STOP`, because nothing found in this session
constitutes a safety or architectural problem: no mandatory-STOP condition was triggered (no CI was ever
altered, no auth bypass, no tenant-isolation breach, no prediction influenced by a known outcome, no
misclassified safety failure, no overstated savings claim - there are no savings claims at all yet to
overstate), and the infrastructure itself is real, tested, and verified working end-to-end. A poor result
would be reportable as a genuine `STOP`-adjacent finding; an *absent* result, honestly reported as absent,
is not the same thing and does not justify stopping a pipeline that has no defects, only insufficient
runtime.

**Concrete next steps, in order:**
1. Let the three currently-enrolled repositories continue accumulating real predictions/ground-truth over
   real elapsed time (days, not this session) - either via periodic manual dispatch or, better, by
   building the small remaining piece (source tarball persisted once in R2, a `scheduled()` Cron handler)
   that makes polling autonomous, since manual dispatch does not scale to the ≥14-day observation window
   the thresholds require.
2. Once the user resolves the GitHub Actions billing block, re-verify `diffci-shadow.yml` actually runs
   (it should now, following this session's permissions fix) and treat this repository's own real commits
   as an additional, first-party observation source alongside the Cloudflare-poll targets.
3. When real volume exists, revisit the Core Stage 2 questions above with actual numbers - not before.
4. Recruiting real design-partner repositories (Gate B) remains the load-bearing prerequisite for
   Phases 12-16 and cannot be substituted with more public third-party repositories, however many are
   added - that would still not answer "would a real team be comfortable with DiffCI eventually
   enforcing," which requires an actual team.

---

**Prospective CI runs analyzed:** 2 real predictions recorded (`unjs/h3`), 0 reconciled to ground truth
yet (both correctly `STILL_PENDING` - too fresh for their own CI to have completed); 3 repositories
enrolled, 3 real baselines established, ~2.5 hours of real elapsed polling
**Real opportunity frequency:** 2/2 observed predictions were `MANDATORY_FALLBACK` (both touched
`package.json`, one also touched the lockfile) - too small a sample to report a rate, but both categorized
correctly and explicably, not anomalously
**Real net CI-time savings vs PATH:** unmeasured (0 reconciled)
**Developer wall-clock savings:** unmeasured (and not yet distinguished from compute savings even in the
pipeline design - see Phase 9 in the architecture doc)
**Prospective failure recall:** unmeasured (0/0 evaluable failures - not reported as 100%, per the
explicit instruction never to claim recall from an empty denominator)
**Credible unsafe misses:** none observed (0 ground-truth reconciliations completed, not the same claim
as "none found after real observation")
**Fallback rate:** 2/2 in the only real sample so far (explicably - lockfile/package.json changes,
matching existing, already-validated global-risk rules, not a new or surprising behavior)
**Prediction latency:** not measured against a real triggered event; the two real predictions completed
in 2,646 ms and 1,055 ms of DiffCI analysis overhead inside the container dispatch, comfortably within
budget - suggestive, not a full latency measurement (no real webhook/event timestamp to compare against
yet)
**DiffCI operating cost:** unmeasured (2 real analyses is not enough volume to cost out)
**Estimated customer savings:** none calculable yet - explicitly not fabricated
**Repository types that benefit most / least:** unknown - 3 repositories from one ecosystem (unjs) is not
a diverse enough sample to characterize this at all
**First paying-customer readiness assessment:** not ready - real prospective evidence has begun accumulating
(2 predictions, 0 reconciled) but is far below any threshold that would support a readiness claim, and no
real design partner has been engaged
**Recommendation: EXTEND SHADOW VALIDATION.** Infrastructure is real, live, and verified working
end-to-end - including on a genuine, unprompted real-world commit during this very session - with no
defects found; it needs real elapsed time and real design-partner engagement next, neither of which this
session could manufacture honestly.
