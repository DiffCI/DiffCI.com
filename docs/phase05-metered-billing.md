# Phase 05 — metered billing at 15%

**Date:** 2026-08-26 · **Exit criterion:** one invoice, paid, reconciled line by line.

DiffCI's stated price is a share of what it saved. That sentence contains the whole difficulty: a share
of a number DiffCI itself produced, about work that was never done, measured against a counterfactual.
Everything in this phase exists because that is an unusually easy thing to get quietly wrong in the
seller's favour.

**Stated up front, because it was raised before the phase started and the direction was to build it
anyway:** the pricing base — 15% of *measured* net savings — cannot be non-zero today. No
client-observed repository can reach MEASURED money, because the selected subset is never executed and
so its duration is never measured. The machinery is complete, the arithmetic is tested, and every
invoice it produces right now totals **$0.00 and says why**. That is the correct output of an honest
pricing rule applied to today's evidence, not a stub.

## What shipped

| File | What it is |
|---|---|
| [`src/billing/cloudflare/schema-metered-invoices.sql`](../src/billing/cloudflare/schema-metered-invoices.sql) | `invoices` + `invoice_lines`. Money is integer cents; never a float, at any layer. |
| [`src/billing/metered.ts`](../src/billing/metered.ts) | Pricing and reconciliation. The only place a chargeable amount is produced. |
| [`src/billing/invoice-store.ts`](../src/billing/invoice-store.ts) | Persistence, org-scoped, with an immutable-once-issued state machine. |
| [`src/billing/invoice-routes.ts`](../src/billing/invoice-routes.ts) | Prepare, list, read, reconcile, issue, mark paid, void. |
| [`src/ui/pages.ts`](../src/ui/pages.ts) | The invoice page: every line, its evidence, and why it charges what it charges. |

Deliberately additive to the existing subscription code rather than merged with it. Those tables
describe a plan and a provider's recurring status machine; this prices a month of DiffCI's own
measurements. The two can coexist — a plan gating features, metering pricing outcomes — but merging them
would let an invoice amount come from a provider's idea of a period rather than from measured evidence.

## The four rules, in the order they bind

**1. Only MEASURED money is chargeable.** A line prices at zero unless its money basis is MEASURED.
ESTIMATED is not "nearly measured" — it is a model, and a model is not an invoice.

**2. A negative month bills zero, never a credit.** Where DiffCI would have run *more* than the
path-rule comparator, the line still appears, still carries its negative quantity, and prices at zero.
Hiding it would make the invoice a summary of the good months only.

**3. The rule travels with the invoice.** The share percentage is stored on each invoice, not read from
configuration at display time. `DIFFCI_SAVINGS_SHARE_PERCENT` changes what *new* invoices use; it cannot
re-price one anybody has already seen.

**4. Every line can be recomputed.** `reconcileInvoice` rebuilds each line from the ledger and reports
every difference. A ledger-digest mismatch is reported *separately* from a value mismatch, because they
mean different things: values differing means the pricing changed, the digest differing means the
evidence changed after issuing (a late observation, an uninstall erasure, a retention sweep). Both must
be visible; only one is a billing bug.

An invoice is also immutable once issued — `issue` is a conditional update that only fires on a draft,
and no method rewrites an issued invoice's amounts. To correct one, void it and issue another, so the
correction is visible rather than the original quietly becoming a different number.

## The real invoice

Pricing the real 12-commit month from Phase 04 (`h3`, `immer`, `execa`):

```
2026-08 — $0.00 (issued)
  15% of measured net savings · basis: -106 net test runs avoided · money evidence: UNKNOWN
  Charges nothing: DiffCI would have run more than the simple path-rule comparator this month,
  so there is nothing to take a share of. This line prices at zero and is never a credit.

  sindresorhus/execa   -151 net   $0.00   UNKNOWN   (negative: never a credit)
  immerjs/immer         +45 net   $0.00   UNKNOWN   (money basis not MEASURED)
  unjs/h3                 0 net   $0.00   UNKNOWN   (no net savings to take a share of)

  Reconciled: every line recomputes to exactly what was invoiced.
```

Two different reasons for zero appear in one invoice, which is the point of having per-line reasons:
immer genuinely saved 45 test runs and still charges nothing because the *money* is not measured; execa
charges nothing because there was nothing to charge for.

## Tests

21 new (1,555 total, typecheck clean):

- 15% of $40.00 measured savings is $6.00; a different share changes the amount and not the measurement.
- ESTIMATED and UNKNOWN both charge zero, with the reason naming the estimate.
- A net-negative month totals zero and never goes below it; the negative quantity is still shown.
- A mixed month charges only the repository that earned it, and lists the ones that did not.
- Cent rounding is half-up, and the total always equals the sum of its chargeable lines — checked
  explicitly, because that is the difference a customer would find first.
- Reconciliation catches an altered line, an inflated total, and evidence deleted after issue.
- Draft → issued → paid, with every out-of-order step refused: a draft cannot be paid, issuing twice is
  not two issues, paying twice is not two payments, and a paid invoice cannot be voided.
- A month is invoiced once: a second attempt returns the first invoice, never a re-priced one.
- Any member can read and reconcile the bill; only an owner or admin can issue it or record payment —
  and the console does not render the buttons to anyone else.
- Another organization is refused at every route and at the console page. The structural tenancy guard
  from Phase 03 now also reads `invoice-store.ts`, for the strongest reason of the three modules: it
  holds money.

## Yours

- **Apply the schema**: `npx tsx scripts/migrate-product-db.ts --remote` (the metered-invoice file is
  appended to the ordered list).
- **Set `DIFFCI_SAVINGS_SHARE_PERCENT`** if 15 is not the number. It is copied onto each invoice.
- **Decide what "paid" means operationally.** `POST .../invoices/:id/paid` records a payment against a
  reference — a bank transfer, a provider id, a note. DiffCI does not collect the money.
- **The pricing question this phase could not answer for you.** A month can be measured, honest and
  negative. Charging 15% of a positive month while a negative month costs the customer nothing is a
  choice that favours DiffCI over time; so is a floor, a cap, or a per-repository rather than
  per-organization basis. The code implements the simplest defensible reading — per-repository lines,
  never negative, summed per month — and stores the rule on each invoice so a different decision is a
  new invoice rather than a rewritten one.

## Not done, stated so it is not discovered later

- **Nothing collects money.** No payment provider is wired to metered invoices: no checkout, no card, no
  dunning, no receipt. `markPaid` is a human recording a fact. The Lemon Squeezy integration in
  `src/billing/` is subscription-only and untouched by this phase.
- **No invoice has been paid**, because none has been non-zero, because no repository has measured
  money. The exit criterion's "paid" is exercised end-to-end in tests against a $0.00 invoice.
- **No tax, no currency but USD, no invoice numbering scheme, no PDF, no email.** An invoice is a row and
  a page.
- **No automatic month-end run.** Invoices are prepared when somebody asks; nothing schedules them.
- **Deleting an organization's observations after an invoice is issued** leaves the invoice standing and
  reconciliation reporting `ledgerChanged`. That is deliberate — the invoice is the record of what was
  measured at the time — but it means a customer exercising erasure will see a bill they can no longer
  fully re-derive.
