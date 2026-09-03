# Website + case studies (workstream W)

Source material for diffci.com. **The site is live** (built as static HTML in `site/`, deployed by
`npm run site:deploy`, DNS pointed 2026-09-04). These files remain the place where wording is argued
with before it reaches `site/`; the evidence ledger below is the authority for every number there.

## What's here

| File | What it is |
|---|---|
| [`01-positioning.md`](01-positioning.md) | Who the site is for, what DiffCI claims, and the claims it deliberately refuses to make |
| [`02-homepage-copy.md`](02-homepage-copy.md) | Section-by-section homepage copy, ready to be built into HTML |
| [`03-evidence-ledger.md`](03-evidence-ledger.md) | Every number that appears in the copy, its source file, and its evidence level |
| [`case-studies/01-calcom.md`](case-studies/01-calcom.md) | cal.com — the activation-quality repository |
| [`case-studies/02-deepseek-harness.md`](case-studies/02-deepseek-harness.md) | deepseek-ai/deepseek-harness — correct refusal under dirty conditions |
| [`case-studies/03-diffci-own-ci.md`](case-studies/03-diffci-own-ci.md) | DiffCI's own CI on Cloudflare containers |
| [`04-open-study.md`](04-open-study.md) | The CC BY 4.0 Open Evidence Study 2026: what was built, the rules, and the founder-only decisions before it is deployed |
| [`../../src/open-study/diffci-open-evidence-2026.ts`](../../src/open-study/diffci-open-evidence-2026.ts) | The study's findings module: the only copy of every figure in the study page, CSV, PDF and licence (`npm run study:render`) |

## Rules these drafts follow

1. **Evidence level is part of the sentence.** Potential / Validated / Billable, per the project's
   savings-evidence model. Copy says "measured" only where a selected run was actually executed and
   timed, and "estimated avoidable" everywhere else. Never "DiffCI saved X" for an inferred figure.
2. **Every number is traceable.** If it appears in the copy, it appears in
   [`03-evidence-ledger.md`](03-evidence-ledger.md) with a path to the report that produced it. A number
   with no ledger row does not ship.
3. **Named repositories are described, not endorsed by.** cal.com, deepseek-harness and the unjs
   repositories are public projects with public CI. None of them are customers, partners, or users of
   DiffCI, and no page may imply otherwise. Each case study states this in its own words, on the page.
4. **Unflattering numbers stay in.** The 44% job-level figure sits next to the 91% test-stage figure.
   The 0.696 preflight recall is on the page. The current shadow cohort is described as thin, because it
   is. The credibility of every other number depends on this one.

## What does not exist yet, and must not be implied

- **No customer.** Nobody outside these repositories has installed DiffCI. There is no design partner.
- **No realized savings.** Nothing has ever been skipped in a repository's real CI. Every measured
  saving in the case studies comes from a controlled replay in DiffCI's own sandbox, not from a
  production CI run that finished faster.
- **No 7-day external shadow report.** The external pilot is mid-ramp with insufficient evidence
  density (see [`../research/2026-08-26-shadow-ramp-load-gate.md`](../research/2026-08-26-shadow-ramp-load-gate.md)).
- **No pricing.** The first transaction is telemetry access in exchange for a report. Nothing is for sale.
