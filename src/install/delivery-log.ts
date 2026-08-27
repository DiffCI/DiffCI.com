/**
 * Webhook delivery de-duplication (2026-08-27).
 *
 * GitHub retries any delivery that did not get a timely 2xx, and the same delivery can be redelivered
 * by hand from the App's settings page at any point afterwards. One of the handlers behind this
 * endpoint erases data - `installation.deleted` drops every observation for the installation and
 * revokes its ingest credentials - so processing a delivery twice is a data-loss question, not a
 * tidiness one.
 *
 * THE ORDERING IS THE MECHANISM. The delivery id is claimed with a conditional INSERT *before* the
 * handler runs. Two concurrent copies of the same delivery therefore race on the primary key rather
 * than on the erase: exactly one wins and proceeds, the loser is refused. Recording afterwards would
 * leave the whole handler's duration as a window in which both copies are mid-erase.
 *
 * WHAT THAT COSTS, STATED PLAINLY. Claiming first means a delivery whose handler then crashes stays
 * `processing` forever and GitHub's retry is refused - the event is dropped rather than half-applied
 * twice. For a destructive handler that is the right side to fail on, but it is a real failure mode:
 * a stuck `processing` row is an operator signal, and `listStale()` exists so it can be found rather
 * than discovered later by a customer whose uninstall did not take effect. A handler that returns a
 * clean error is marked `failed` instead, and IS eligible for GitHub's retry.
 */
import type { D1Binding } from "../ingest/token.js";

export type DeliveryClaim =
  /** This delivery is ours to process. */
  | { ok: true; claimed: true }
  /** Someone already has it - a retry, a manual redelivery, or a concurrent duplicate. */
  | { ok: false; claimed: false; reason: "duplicate"; previousStatus: "processing" | "completed" };

export interface WebhookDeliveryRecord {
  deliveryId: string;
  event: string;
  action?: string;
  status: "processing" | "completed" | "failed";
  receivedAt: string;
  completedAt?: string;
  result?: string;
}

export interface WebhookDeliveryStore {
  /**
   * Atomically claim `deliveryId` for processing. Returns `claimed: true` at most once per delivery
   * id, except that a previously `failed` delivery may be claimed again (GitHub's retry of something
   * that genuinely errored should be allowed to succeed).
   */
  claim(input: { deliveryId: string; event: string; action?: string }): Promise<DeliveryClaim>;
  /** Mark a claimed delivery finished. `result` is a short operator-facing summary, never a payload. */
  complete(deliveryId: string, result: string): Promise<void>;
  /** Mark a claimed delivery as cleanly failed, making it eligible for redelivery. */
  fail(deliveryId: string, result: string): Promise<void>;
  get(deliveryId: string): Promise<WebhookDeliveryRecord | null>;
  /** Deliveries stuck in `processing` for longer than `olderThanMs` - the crashed-handler signal. */
  listStale(olderThanMs: number): Promise<WebhookDeliveryRecord[]>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function toRecord(row: Record<string, unknown>): WebhookDeliveryRecord {
  return {
    deliveryId: String(row.delivery_id),
    event: String(row.event),
    action: row.action === null || row.action === undefined ? undefined : String(row.action),
    status: String(row.status) as WebhookDeliveryRecord["status"],
    receivedAt: String(row.received_at),
    completedAt: row.completed_at === null || row.completed_at === undefined ? undefined : String(row.completed_at),
    result: row.result === null || row.result === undefined ? undefined : String(row.result),
  };
}

export function makeD1WebhookDeliveryStore(db: D1Binding): WebhookDeliveryStore {
  return {
    async claim({ deliveryId, event, action }) {
      const receivedAt = nowIso();
      // ON CONFLICT ... DO UPDATE ... WHERE status = 'failed' is the whole of the atomicity. A fresh id
      // inserts; a previously failed id is re-claimed by the UPDATE; a 'processing' or 'completed' id
      // matches neither and reports zero changes. One statement, so no read-then-write race exists.
      const result = await db
        .prepare(
          `INSERT INTO webhook_deliveries (delivery_id, event, action, status, received_at)
           VALUES (?, ?, ?, 'processing', ?)
           ON CONFLICT (delivery_id) DO UPDATE SET
             status = 'processing',
             received_at = excluded.received_at,
             completed_at = NULL,
             result = NULL
           WHERE webhook_deliveries.status = 'failed'`,
        )
        .bind(deliveryId, event, action ?? null, receivedAt)
        .run();

      const changes = Number((result as { meta?: { changes?: number } }).meta?.changes ?? 0);
      if (changes > 0) return { ok: true, claimed: true };

      const existing = await db.prepare(`SELECT status FROM webhook_deliveries WHERE delivery_id = ?`).bind(deliveryId).first<Record<string, unknown>>();
      const previousStatus = existing?.status === "completed" ? "completed" : "processing";
      return { ok: false, claimed: false, reason: "duplicate", previousStatus };
    },

    async complete(deliveryId, result) {
      await db
        .prepare(`UPDATE webhook_deliveries SET status = 'completed', completed_at = ?, result = ? WHERE delivery_id = ?`)
        .bind(nowIso(), result.slice(0, 500), deliveryId)
        .run();
    },

    async fail(deliveryId, result) {
      await db
        .prepare(`UPDATE webhook_deliveries SET status = 'failed', completed_at = ?, result = ? WHERE delivery_id = ?`)
        .bind(nowIso(), result.slice(0, 500), deliveryId)
        .run();
    },

    async get(deliveryId) {
      const row = await db.prepare(`SELECT * FROM webhook_deliveries WHERE delivery_id = ?`).bind(deliveryId).first<Record<string, unknown>>();
      return row ? toRecord(row) : null;
    },

    async listStale(olderThanMs) {
      const cutoff = new Date(Date.now() - olderThanMs).toISOString();
      // `<=`, not `<`: with olderThanMs = 0 the cutoff is "now", and a row claimed within the same
      // millisecond must still count as stale. An exclusive bound would make listStale(0) - "show me
      // everything currently in flight" - silently return nothing, which is the opposite of what an
      // operator reaching for it needs.
      const rows = await db
        .prepare(`SELECT * FROM webhook_deliveries WHERE status = 'processing' AND received_at <= ? ORDER BY received_at ASC LIMIT 100`)
        .bind(cutoff)
        .all<Record<string, unknown>>();
      return (rows.results ?? []).map(toRecord);
    },
  };
}
