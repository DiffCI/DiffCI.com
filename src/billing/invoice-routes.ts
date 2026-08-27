/**
 * Invoice routes (Phase 05, 2026-08-26).
 *
 * Membership before anything, as everywhere else - plus a role check on the two actions that are
 * financial rather than informational. Issuing an invoice and recording it paid are the first things in
 * this product a member could do that has money attached, so they require owner or admin. Reading is
 * open to any member: a bill people cannot see is a bill they cannot dispute.
 */
import type { ProductStore } from "../product/store.js";
import type { RouteOutcome } from "../product/routes.js";
import type { LedgerRouteDeps } from "../ledger/routes.js";
import { getMonthlyLedgerForOrganization } from "../ledger/routes.js";
import { buildInvoiceFromLedger, reconcileInvoice, type ReconciliationResult } from "./metered.js";
import type { InvoiceStore, StoredInvoice } from "./invoice-store.js";

export interface InvoiceRouteDeps extends LedgerRouteDeps {
  productStore: ProductStore;
  invoiceStore: InvoiceStore;
  savingsSharePercent?: number;
}

async function isOwnerOrAdmin(deps: InvoiceRouteDeps, organizationId: string, userId: string): Promise<boolean> {
  const membership = await deps.productStore.getMembership(organizationId, userId);
  return membership?.role === "owner" || membership?.role === "admin";
}

/**
 * Prepares (or returns) the invoice for a month. Idempotent by construction: a month already invoiced
 * comes back as it was, never re-priced, because an invoice someone has already seen must not silently
 * become a different number.
 */
export async function prepareInvoiceForMonth(
  deps: InvoiceRouteDeps,
  userId: string,
  organizationId: string,
  month: string,
): Promise<RouteOutcome<{ invoice: StoredInvoice; created: boolean }>> {
  if (!(await deps.productStore.isMember(organizationId, userId))) return { ok: false, error: "unauthorized" };

  const existing = await deps.invoiceStore.getForPeriod(organizationId, month);
  if (existing) return { ok: true, data: { invoice: existing, created: false } };

  const ledger = await getMonthlyLedgerForOrganization(deps, userId, organizationId, month);
  if (!ledger.ok) return { ok: false, error: ledger.error };

  const draft = await buildInvoiceFromLedger(ledger.data, { savingsSharePercent: deps.savingsSharePercent });
  return { ok: true, data: await deps.invoiceStore.createDraftIfAbsent(draft) };
}

export async function listInvoicesForOrganization(
  deps: InvoiceRouteDeps,
  userId: string,
  organizationId: string,
): Promise<RouteOutcome<StoredInvoice[]>> {
  if (!(await deps.productStore.isMember(organizationId, userId))) return { ok: false, error: "unauthorized" };
  return { ok: true, data: await deps.invoiceStore.listForOrganization(organizationId) };
}

export async function getInvoiceForOrganization(
  deps: InvoiceRouteDeps,
  userId: string,
  organizationId: string,
  invoiceId: string,
): Promise<RouteOutcome<StoredInvoice>> {
  if (!(await deps.productStore.isMember(organizationId, userId))) return { ok: false, error: "unauthorized" };
  const invoice = await deps.invoiceStore.getForOrganization(organizationId, invoiceId);
  return invoice ? { ok: true, data: invoice } : { ok: false, error: "not_found" };
}

/**
 * Recomputes an invoice from today's ledger and reports every difference, line by line. Available to any
 * member, deliberately: the customer checking the bill is the point of it existing.
 */
export async function reconcileInvoiceForOrganization(
  deps: InvoiceRouteDeps,
  userId: string,
  organizationId: string,
  invoiceId: string,
): Promise<RouteOutcome<{ invoice: StoredInvoice; reconciliation: ReconciliationResult }>> {
  const outcome = await getInvoiceForOrganization(deps, userId, organizationId, invoiceId);
  if (!outcome.ok) return outcome;
  const invoice = outcome.data;

  const ledger = await getMonthlyLedgerForOrganization(deps, userId, organizationId, invoice.periodMonth);
  if (!ledger.ok) return { ok: false, error: ledger.error };

  const reconciliation = await reconcileInvoice(
    {
      organizationId: invoice.organizationId,
      periodMonth: invoice.periodMonth,
      currency: "USD",
      savingsSharePercent: invoice.savingsSharePercent,
      netTestsAvoided: invoice.netTestsAvoided,
      netSavingsUsdCents: invoice.netSavingsUsdCents,
      totalUsdCents: invoice.totalUsdCents,
      evidenceTier: invoice.evidenceTier,
      chargeable: invoice.chargeable,
      notChargeableReason: invoice.notChargeableReason,
      ledgerDigest: invoice.ledgerDigest,
      lines: invoice.lines,
    },
    ledger.data,
  );
  return { ok: true, data: { invoice, reconciliation } };
}

export async function issueInvoice(
  deps: InvoiceRouteDeps,
  userId: string,
  organizationId: string,
  invoiceId: string,
): Promise<RouteOutcome<{ issued: boolean }>> {
  if (!(await isOwnerOrAdmin(deps, organizationId, userId))) return { ok: false, error: "unauthorized" };
  const issued = await deps.invoiceStore.issue(organizationId, invoiceId);
  if (!issued) return { ok: false, error: "not_found" };
  await deps.productStore.recordAuditEvent({
    organizationId,
    actorUserId: userId,
    action: "invoice.issued",
    targetType: "invoice",
    targetId: invoiceId,
  });
  return { ok: true, data: { issued } };
}

export async function markInvoicePaid(
  deps: InvoiceRouteDeps,
  userId: string,
  organizationId: string,
  invoiceId: string,
  reference: string,
): Promise<RouteOutcome<{ paid: boolean }>> {
  if (!(await isOwnerOrAdmin(deps, organizationId, userId))) return { ok: false, error: "unauthorized" };
  const paid = await deps.invoiceStore.markPaid(organizationId, invoiceId, reference);
  if (!paid) return { ok: false, error: "not_found" };
  await deps.productStore.recordAuditEvent({
    organizationId,
    actorUserId: userId,
    action: "invoice.paid",
    targetType: "invoice",
    targetId: invoiceId,
    // The reference, not the amount: the amount is on the invoice, and duplicating it here would create
    // a second place for it to be wrong.
    metadata: { reference },
  });
  return { ok: true, data: { paid } };
}

export async function voidInvoiceForOrganization(
  deps: InvoiceRouteDeps,
  userId: string,
  organizationId: string,
  invoiceId: string,
): Promise<RouteOutcome<{ voided: boolean }>> {
  if (!(await isOwnerOrAdmin(deps, organizationId, userId))) return { ok: false, error: "unauthorized" };
  const voided = await deps.invoiceStore.voidInvoice(organizationId, invoiceId);
  if (!voided) return { ok: false, error: "not_found" };
  await deps.productStore.recordAuditEvent({
    organizationId,
    actorUserId: userId,
    action: "invoice.voided",
    targetType: "invoice",
    targetId: invoiceId,
  });
  return { ok: true, data: { voided } };
}
