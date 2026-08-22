/**
 * D1 persistence for usage_events (Part 5/6). Idempotency is enforced at TWO layers: the derived key
 * itself (organization + event_type + source_id, per Part 6's suggested concept) AND the database's own
 * UNIQUE constraint on idempotency_key + INSERT OR IGNORE - so even two concurrent requests racing the
 * exact same underlying event can only ever result in one counted row, regardless of application-level
 * timing.
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

import type { RecordUsageEventInput, UsageEvent, UsageEventType } from "./types.js";

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Part 6's suggested concept, made concrete: one (organization, event_type, source_id) triple can only
 * ever produce one usage_events row. This means the SAME GitHub webhook / reconciliation / runner
 * completion redelivered later derives the exact same key and is silently ignored on the second and
 * subsequent attempts - by construction, not by a fragile "have we seen this before" cache.
 */
export function deriveIdempotencyKey(organizationId: string, eventType: UsageEventType, sourceId: string): string {
  return `${organizationId}:${eventType}:${sourceId}`;
}

function rowToUsageEvent(row: Record<string, unknown>): UsageEvent {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    repositoryId: (row.repository_id as string | null) ?? undefined,
    eventType: row.event_type as UsageEventType,
    quantity: row.quantity as number,
    unit: row.unit as string,
    sourceType: row.source_type as string,
    sourceId: row.source_id as string,
    occurredAt: row.occurred_at as string,
    recordedAt: row.recorded_at as string,
    idempotencyKey: row.idempotency_key as string,
  };
}

export interface UsageStore {
  /** Returns null if this exact (organization, event_type, source_id) was already recorded - the
   * caller's expected, routine "duplicate delivery" outcome, not an error. */
  recordUsageEventIfNew(input: RecordUsageEventInput): Promise<UsageEvent | null>;
  listEventsInRange(organizationId: string, startIso: string, endIso: string): Promise<UsageEvent[]>;
  sumQuantityInRange(organizationId: string, eventType: UsageEventType, startIso: string, endIso: string): Promise<number>;
  countDistinctActiveRepositories(organizationId: string, startIso: string, endIso: string): Promise<number>;
}

export function makeD1UsageStore(db: D1Binding): UsageStore {
  return {
    async recordUsageEventIfNew(input) {
      const idempotencyKey = deriveIdempotencyKey(input.organizationId, input.eventType, input.sourceId);
      const id = crypto.randomUUID();
      const recordedAt = nowIso();
      const result = await db
        .prepare(
          `INSERT OR IGNORE INTO usage_events
             (id, organization_id, repository_id, event_type, quantity, unit, source_type, source_id,
              occurred_at, recorded_at, idempotency_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          input.organizationId,
          input.repositoryId ?? null,
          input.eventType,
          input.quantity,
          input.unit,
          input.sourceType,
          input.sourceId,
          input.occurredAt,
          recordedAt,
          idempotencyKey,
        )
        .run();
      if ((result.meta?.changes ?? 0) === 0) return null; // duplicate - already recorded
      return { id, ...input, recordedAt, idempotencyKey };
    },

    async listEventsInRange(organizationId, startIso, endIso) {
      const { results } = await db
        .prepare(`SELECT * FROM usage_events WHERE organization_id = ? AND occurred_at >= ? AND occurred_at < ? ORDER BY occurred_at ASC`)
        .bind(organizationId, startIso, endIso)
        .all<Record<string, unknown>>();
      return results.map(rowToUsageEvent);
    },

    async sumQuantityInRange(organizationId, eventType, startIso, endIso) {
      const row = await db
        .prepare(`SELECT COALESCE(SUM(quantity), 0) as total FROM usage_events WHERE organization_id = ? AND event_type = ? AND occurred_at >= ? AND occurred_at < ?`)
        .bind(organizationId, eventType, startIso, endIso)
        .first<{ total: number }>();
      return row?.total ?? 0;
    },

    async countDistinctActiveRepositories(organizationId, startIso, endIso) {
      const row = await db
        .prepare(`SELECT COUNT(DISTINCT repository_id) as n FROM usage_events WHERE organization_id = ? AND repository_id IS NOT NULL AND occurred_at >= ? AND occurred_at < ?`)
        .bind(organizationId, startIso, endIso)
        .first<{ n: number }>();
      return row?.n ?? 0;
    },
  };
}
