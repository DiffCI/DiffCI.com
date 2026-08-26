# Rainmatter application draft — DiffCI (closed-source, grant + ROFR)

Status: DRAFT for the founder to submit by hand via https://forms.gle/zg3QSsKpeBWqTgpy8
(Rainmatter reviews in 2–3 days; silence = no. Attach a short deck built from sections 2–7.)

All numbers below are copied from the research reports in `docs/research/` as of 2026-08-22.
Nothing here is rounded up. Where a figure is unmeasured, it says so.

---

## 1. Which Rainmatter door, and why

- **Rainmatter Foundation (rainmatter.org)** is a nonprofit grant-maker. Its public grantee list is
  nonprofits, collectives and research institutions, and it funds digital *public* goods. A grant from
  a charitable entity to a private company for proprietary R&D, with a commercial ROFR going to an
  affiliated fund, is a private-benefit problem under Indian charitable-entity rules. Do not pitch this
  structure to the Foundation.
- **Rainmatter (rainmatter.com, the Zerodha fund)** invests ₹50 lakh – ₹100 crore in Indian founders in
  fintech, **climate**, health and media, at any stage, with no board seats. It accepts out-of-sector
  applications "if founders believe Rainmatter can help". This is the right door.
- What to ask the fund for: a **research grant with a ROFR** (see §8). Expect them to counter with
  straight equity or a convertible; decide your walk-away before the call.

## 2. One-line

DiffCI predicts which CI tests a code change can safely skip, using a dependency graph of the repo, and
proves the prediction against ground truth before it is ever allowed to skip anything — so CI burns
less compute, electricity, water and carbon without becoming less safe.

## 3. Problem

Every push to a software repository re-runs the full test suite, almost always on cloud runners. The
majority of that work is wasted: most changes cannot affect most tests. Path-based filtering (the
industry's current answer) is coarse and unsafe on real dependency structures. The result is a large,
invisible, recurring energy and water cost spread across millions of repositories.

## 4. What has actually been built and measured (Stage 0 → Stage 2F)

**Stage 0 — 20 real repositories, 2,000 real commit deltas, real execution**
(`docs/research/2026-08-21-stage0-full-experiment-final-report.md`)

| Metric | Value |
|---|---|
| Deltas where a discriminative opportunity existed | 565 / 1,899 eligible (29.8%) |
| On those: DiffCI wins vs path-filtering | 533 (94.3%), ties 32, **path-filtering wins 0** |
| Median conditional reduction vs path-filtering | **95.0%** (mean 66.0%) |
| Aggregate (workload-weighted) reduction vs FULL | 13.2% |
| Aggregate reduction relative to path-filtering | **4.16%** (bootstrap 95% CI [-4.8%, +47.9%]) |
| Small repositories aggregate reduction | 44.9% |
| Large repositories aggregate reduction | -0.95% (≈ zero) |
| Deltas forced to mandatory fallback (safety) | 60.3% |
| Correctness bugs found in 2,000 deltas | 1 (0.05%), handled per protocol, not hidden |

**Stage 2F — live prospective shadow mode (predictions made *before* CI runs, reconciled after)**
(`docs/research/stage2f-observation-log.md`, Day 1, 2026-08-22)

- 65 real runs reconciled, 28 discriminative opportunities, 152 cron polls, zero gaps, zero errors.
- **False negatives: 0** — no case where DiffCI would have skipped a test that then failed.
- Algorithm frozen before observation; a pre-registered 14-day window runs to 2026-09-04.

**Preflight — predicting CI failures before they run**
(`docs/research/2026-08-22-preflight-p1-replay-results.md`)

- Leakage-safe replay on historical failures: prevention recall **0.696** (16/23 evaluable).
  The first run showed 0.958; it was investigated, found to be leaking, and thrown away.

## 5. Why this is a climate application, honestly

The mechanism is simple: fewer CI minutes → fewer runner-hours → less electricity → less cooling
water → less CO₂e. The link is real but **DiffCI has not yet published a kWh/litre/CO₂e figure**, and
this application does not invent one. What the grant buys is the measurement.

Conversion chain to be filled with *cited* factors (cloud-provider sustainability reports, IEA/Ember
grid intensity, provider WUE), not estimates:

    CI minutes avoided
      × vCPUs per runner × kWh per vCPU-hour (incl. PUE)      → kWh
      × grid intensity (kgCO₂e/kWh) for the runner region     → kgCO₂e
      × water-use effectiveness (L/kWh)                        → litres

Realistic framing for the deck: the *conditional* effect is large (95% median when an opportunity
exists) and the *aggregate* effect today is small (4.2%) because safety fallbacks dominate. The research
question is whether the aggregate can be raised toward the conditional number without losing the
0-false-negative record. That is a measurable, falsifiable question — which is what separates this
from a green-washing pitch.

## 6. What the money is for (12 months)

1. Finish the pre-registered Stage 2F window and publish the result whatever it says.
2. Recruit 5–10 design-partner repositories (the gate that cannot be passed with public repos).
3. Reduce the 60% mandatory-fallback rate on large repositories — the single lever on aggregate impact.
4. Produce an audited energy/water/CO₂e measurement note using the chain in §5.
5. Harden the Cloudflare Workers deployment already running (`wrangler.*.jsonc`) for partner traffic.

Ask: ₹ [amount] as a research grant, milestones = items 1–4, quarterly written updates.

## 7. Team, risks, monetisation (form fields)

- Team: [founder name], solo technical founder; prior product DentalPresence.in. [add collaborators]
- Key risks (state them, they will ask): aggregate effect may stay small on large repos; design-partner
  recruitment; GitHub platform dependence; Stage 2F could surface a false negative.
- Monetisation if research succeeds: per-seat / per-repo SaaS for CI cost reduction; the measured
  carbon figure becomes a reportable metric for customers' own ESG disclosures.
- Not open source. The methodology and measurement data will be published; the product will not.

## 8. The ROFR offer — draft terms (get an Indian startup lawyer before sending)

Offer to Rainmatter in exchange for a non-dilutive research grant:

1. **Right of First Refusal** on the first priced equity round following commercial launch, for an
   amount up to [X]× the grant, on the same terms as the lead.
2. **Right of First Offer** on any exclusive commercial licence or sale of the DiffCI core.
3. **Grant-to-equity option**: at the first priced round Rainmatter may convert the grant at a
   [15–20]% discount to that round's price (this is what makes the "grant" investable for a fund).
4. ROFR/ROFO expire if unexercised within 30 days of notice, or [5] years after the grant.
5. No IP assignment, no open-source obligation, no board seat (matches their stated model).

Why a fund might accept: cheap optionality on a company they would otherwise never see at seed.
Why they might not: funds hold equity; a bare ROFR has no upside. Term 3 is what closes that gap —
without it, expect a straight convertible counter-offer.

## 9. Before you submit — checklist

- [ ] DPIIT startup recognition (Indian founder/entity requirement).
- [ ] Replace every `[bracket]` above.
- [ ] 8–10 slide deck: problem, mechanism, the two tables in §4, the §5 chain, ask, ROFR summary.
- [ ] Decide walk-away: will you take equity instead of a grant if they refuse the ROFR structure?
- [ ] Keep claims at the level of §4. Nothing about "saving X tonnes" until §5 is measured.
