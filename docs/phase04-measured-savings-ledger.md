# Phase 04 — the measured savings ledger

**Date:** 2026-08-26 · **Exit criterion:** one month of MEASURED net savings + one honest zero.

Phase 03 made observations arrive. Phase 04 turns a month of them into a number a customer could act on —
and, on the first real data it was pointed at, that number is **negative**.

## The two words that do the work

**Net.** [`src/usage/savings.ts`](../src/usage/savings.ts) computes `testsAvoided = total − selected`:
DiffCI measured against running the whole suite. Phase 01 established that this comparator is a strawman
— a simple path-rule CI already scopes most commits on most repositories, so "everything" is not what the
customer would otherwise have run. The ledger measures against the comparator each observation carries
with it: `net = baselineSelected − diffciSelected`. The vs-full-suite figure is still computed and shown,
in a muted column, so the gap between the honest number and the flattering one is visible rather than a
matter of trust.

Net is allowed to be negative, and is never clamped. On Phase 01's own cohort the simple path rule beat
DiffCI on two of nine repositories. A ledger that cannot report that cannot be believed when it reports
the opposite.

**Measured.** [`src/usage/economics-classification.ts`](../src/usage/economics-classification.ts) already
carried the rule, from the external-shadow-pilot work: in pure observation mode the DiffCI side of an
avoidable-work figure is *never* measured, because it is never executed. So:

- **Counts are MEASURED.** Both sides are counted from the same test universe the engine discovered.
- **Time and money are, at best, ESTIMATED**, and are UNKNOWN without a per-repository duration
  observation — which no client-observed repository has yet, so today they are all UNKNOWN.
- **Nothing is billable.** Every row and every total carries `billable: false` and the reason. Phase 05
  needs that reason to disappear for a real cause, not to be deleted.

`NetSavingsInput` cannot express a "measured" duration — the type does not admit the value — so the
"never MEASURED while observation-only" rule is enforced by construction rather than by a check.

## What shipped

| File | What it is |
|---|---|
| [`src/ledger/net-savings.ts`](../src/ledger/net-savings.ts) | One observation's net figure, with its evidence tier. |
| [`src/ledger/ledger.ts`](../src/ledger/ledger.ts) | A month, per repository, with a verdict per row. |
| [`src/ledger/routes.ts`](../src/ledger/routes.ts) | `GET /v1/organizations/:id/ledger?month=YYYY-MM`, membership-checked. |
| [`src/ui/pages.ts`](../src/ui/pages.ts) | The ledger page in the console. |

Four verdicts, three of which are not a saving: `NO_DATA` (nothing comparable arrived),
`NO_OPPORTUNITY` (the honest zero), `NET_NEGATIVE` (DiffCI would have run more), `NET_POSITIVE`.
Net-negative rows sort to the top: bad news should not need scrolling to find.

## Measured, on real repositories

Twelve real commits — four each from `unjs/h3`, `immerjs/immer` and `sindresorhus/execa` — run through
the real client observer, posted through the real ingest path, and totalled by the real ledger code.
Nothing here is a fixture except the passage of time.

| Repository | Verdict | Net avoided | vs full suite | Comparable |
|---|---|---:|---:|---:|
| `sindresorhus/execa` | **DiffCI would have run more** | **−151** | 0 | 4/4 |
| `immerjs/immer` | net saving | +45 | 91 | 4/4 |
| `unjs/h3` | nothing to skip | 0 | 70 | 4/4 |
| **Total** | | **−106** | **+161** | 12/12 |

Read the last row twice. Against the honest comparator this month is **−106 tests**: DiffCI would have
run 106 more test files than a simple path-rule CI would have. Against "run everything" the same twelve
commits would have read as **+161**, and that is the number almost any other tool would have printed.

The detail behind execa's −151: on one commit the path rule scoped to zero tests while DiffCI fell back
to FULL and would have run all 151. One commit, one fallback, and the month is negative. That is what
measuring against a real comparator does to a savings claim.

`unjs/h3` is the honest zero — four commits, all comparable, and both DiffCI and the comparator would
have run the same thing every time. Not a failure, and not a number to hide: most commits on most
repositories genuinely have nothing to skip.

All three verdicts appeared without being engineered for. Reproduce with
`npx tsx .scratch/ledger-demo.ts <clones-dir> 4`.

## Tests

25 new (1,532 total, typecheck clean). The ones that carry weight:

- The honest zero is `NO_OPPORTUNITY` with `countTier: MEASURED` — zero is a measured result, not an
  absence of one.
- A net-negative repository is reported as `NET_NEGATIVE`, sorted to the top, and priced as a negative
  amount when a duration assumption exists — DiffCI costing more must never read as money saved.
- An empty test universe is never "everything avoided" (Phase 01 F1, in the ledger).
- A total is never more certain than its least certain repository: one repository without duration data
  makes the month's time UNKNOWN, while counts stay MEASURED.
- Even with a cost model and a real historical duration, `timeTier` comes out ESTIMATED and
  `billable` stays false.
- The month is refused to a non-member, as JSON and as a page.

## Yours

- **Nothing to deploy.** The ledger reads tables Phase 03 already added; no new schema, no new secret.
- **The month above is four commits per repository, not a month.** A real month needs the Phase 02
  observation window actually running somewhere.

## Not done, stated so it is not discovered later

- **No time or money figure exists for any real repository.** The ledger can compute them from a
  per-repository seconds-per-test observation, and nothing supplies one for a client-observed repository:
  `src/usage/duration-capture.ts` derives durations from Stage 2F shadow predictions via the GitHub API,
  which client-side observation deliberately does not use. Wiring a client-side duration source (the
  action reading its own repository's completed workflow-run job timings) is the obvious next step and is
  not in this phase.
- **MEASURED time is unreachable by design, not by omission.** It requires executing the selected subset
  and timing it — i.e. leaving observation-only mode. That is a product decision with a safety case
  attached, not a missing feature.
- **The ledger reads at most 1,000 observations per month** and does not paginate. Fine for a pilot,
  wrong for a busy monorepo.
- **No month-over-month view, no CSV export, no per-observation drill-down** from the ledger page.
- **The console shows no currency**, because every currency figure available today would be UNKNOWN. When
  one is ESTIMATED it will need a label at least as loud as the number.
