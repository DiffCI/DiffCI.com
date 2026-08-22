/**
 * D1 persistence for billing_customers/subscriptions/billing_events (src/billing/cloudflare/schema.sql,
 * same diffci-product database as src/product/store.ts). Same D1Binding idiom as the rest of the
 * codebase - see src/product/store.ts's header comment for why it's duplicated rather than shared.
 */
export interface D1Binding {
  prepare(query: string): {
    bind(...values: unknown[]): {
      run(): Promise<{ meta?: { changes?: number } }>;
      all<T = unknown>(): Promise<{ results: T[] }>;
      first<T = unknown>(): Promise<T | null>;
    };
  };
}

import type { BillingCustomer, BillingEvent, Subscription, SubscriptionStatus } from "./types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  return crypto.randomUUID();
}

function rowToSubscription(row: Record<string, unknown>): Subscription {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    provider: row.provider as "lemonsqueezy",
    providerSubscriptionId: row.provider_subscription_id as string,
    status: row.status as SubscriptionStatus,
    rawProviderStatus: row.raw_provider_status as string,
    planId: row.plan_id as string,
    providerVariantId: row.provider_variant_id as string,
    currentPeriodStart: (row.current_period_start as string | null) ?? undefined,
    currentPeriodEnd: (row.current_period_end as string | null) ?? undefined,
    cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export interface BillingStore {
  upsertCustomer(input: { organizationId: string; provider: "lemonsqueezy"; providerCustomerId: string }): Promise<BillingCustomer>;
  getCustomerByOrganization(organizationId: string, provider: "lemonsqueezy"): Promise<BillingCustomer | null>;

  upsertSubscription(input: {
    organizationId: string;
    provider: "lemonsqueezy";
    providerSubscriptionId: string;
    status: SubscriptionStatus;
    rawProviderStatus: string;
    planId: string;
    providerVariantId: string;
    currentPeriodStart?: string;
    currentPeriodEnd?: string;
    cancelAtPeriodEnd: boolean;
  }): Promise<Subscription>;
  getSubscriptionByOrganization(organizationId: string, provider: "lemonsqueezy"): Promise<Subscription | null>;
  getSubscriptionByProviderId(provider: "lemonsqueezy", providerSubscriptionId: string): Promise<Subscription | null>;

  /** Returns null (no insert performed) if idempotencyKey already exists - the caller's idempotency
   * gate (Part 7/20). Never throws on a duplicate; a duplicate is an expected, routine occurrence
   * (webhook retries), not an error. */
  recordBillingEventIfNew(input: Omit<BillingEvent, "id" | "receivedAt" | "processedAt" | "processingStatus"> & { processingStatus?: BillingEvent["processingStatus"] }): Promise<BillingEvent | null>;
  markBillingEventProcessed(id: string, status: BillingEvent["processingStatus"], error?: string): Promise<void>;
}

export function makeD1BillingStore(db: D1Binding): BillingStore {
  return {
    async upsertCustomer({ organizationId, provider, providerCustomerId }) {
      const id = newId();
      const ts = nowIso();
      await db
        .prepare(
          `INSERT INTO billing_customers (id, organization_id, provider, provider_customer_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (organization_id, provider) DO UPDATE SET
             provider_customer_id = excluded.provider_customer_id, updated_at = excluded.updated_at`,
        )
        .bind(id, organizationId, provider, providerCustomerId, ts, ts)
        .run();
      const row = await db
        .prepare(`SELECT * FROM billing_customers WHERE organization_id = ? AND provider = ?`)
        .bind(organizationId, provider)
        .first<Record<string, unknown>>();
      const r = row!;
      return {
        id: r.id as string,
        organizationId: r.organization_id as string,
        provider: r.provider as "lemonsqueezy",
        providerCustomerId: r.provider_customer_id as string,
        createdAt: r.created_at as string,
        updatedAt: r.updated_at as string,
      };
    },

    async getCustomerByOrganization(organizationId, provider) {
      const row = await db
        .prepare(`SELECT * FROM billing_customers WHERE organization_id = ? AND provider = ?`)
        .bind(organizationId, provider)
        .first<Record<string, unknown>>();
      if (!row) return null;
      return {
        id: row.id as string,
        organizationId: row.organization_id as string,
        provider: row.provider as "lemonsqueezy",
        providerCustomerId: row.provider_customer_id as string,
        createdAt: row.created_at as string,
        updatedAt: row.updated_at as string,
      };
    },

    async upsertSubscription(input) {
      const id = newId();
      const ts = nowIso();
      await db
        .prepare(
          `INSERT INTO subscriptions
             (id, organization_id, provider, provider_subscription_id, status, raw_provider_status,
              plan_id, provider_variant_id, current_period_start, current_period_end,
              cancel_at_period_end, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (provider, provider_subscription_id) DO UPDATE SET
             status = excluded.status,
             raw_provider_status = excluded.raw_provider_status,
             plan_id = excluded.plan_id,
             provider_variant_id = excluded.provider_variant_id,
             current_period_start = excluded.current_period_start,
             current_period_end = excluded.current_period_end,
             cancel_at_period_end = excluded.cancel_at_period_end,
             updated_at = excluded.updated_at`,
        )
        .bind(
          id,
          input.organizationId,
          input.provider,
          input.providerSubscriptionId,
          input.status,
          input.rawProviderStatus,
          input.planId,
          input.providerVariantId,
          input.currentPeriodStart ?? null,
          input.currentPeriodEnd ?? null,
          input.cancelAtPeriodEnd ? 1 : 0,
          ts,
          ts,
        )
        .run();
      const row = await db
        .prepare(`SELECT * FROM subscriptions WHERE provider = ? AND provider_subscription_id = ?`)
        .bind(input.provider, input.providerSubscriptionId)
        .first<Record<string, unknown>>();
      return rowToSubscription(row!);
    },

    async getSubscriptionByOrganization(organizationId, provider) {
      const row = await db
        .prepare(`SELECT * FROM subscriptions WHERE organization_id = ? AND provider = ? ORDER BY created_at DESC LIMIT 1`)
        .bind(organizationId, provider)
        .first<Record<string, unknown>>();
      return row ? rowToSubscription(row) : null;
    },

    async getSubscriptionByProviderId(provider, providerSubscriptionId) {
      const row = await db
        .prepare(`SELECT * FROM subscriptions WHERE provider = ? AND provider_subscription_id = ?`)
        .bind(provider, providerSubscriptionId)
        .first<Record<string, unknown>>();
      return row ? rowToSubscription(row) : null;
    },

    async recordBillingEventIfNew(input) {
      const id = newId();
      const ts = nowIso();
      const result = await db
        .prepare(
          `INSERT OR IGNORE INTO billing_events
             (id, idempotency_key, provider, provider_event_id, event_type, organization_id,
              received_at, processing_status, payload_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          input.idempotencyKey,
          input.provider,
          input.providerEventId ?? null,
          input.eventType,
          input.organizationId ?? null,
          ts,
          input.processingStatus ?? "received",
          input.payloadHash,
        )
        .run();
      if ((result.meta?.changes ?? 0) === 0) return null; // already existed - duplicate delivery
      return {
        id,
        idempotencyKey: input.idempotencyKey,
        provider: input.provider,
        providerEventId: input.providerEventId,
        eventType: input.eventType,
        organizationId: input.organizationId,
        receivedAt: ts,
        processingStatus: input.processingStatus ?? "received",
        payloadHash: input.payloadHash,
      };
    },

    async markBillingEventProcessed(id, status, error) {
      await db
        .prepare(`UPDATE billing_events SET processing_status = ?, processed_at = ?, error = ? WHERE id = ?`)
        .bind(status, nowIso(), error ?? null, id)
        .run();
    },
  };
}
