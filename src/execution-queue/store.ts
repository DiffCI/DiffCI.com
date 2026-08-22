export interface D1Binding {
  prepare(query: string): {
    bind(...values: unknown[]): {
      run(): Promise<{ meta?: { changes?: number } }>;
      all<T = unknown>(): Promise<{ results: T[] }>;
      first<T = unknown>(): Promise<T | null>;
    };
  };
}

import type { EnqueueInput, QueueItem, QueueItemStatus } from "./types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function rowToQueueItem(row: Record<string, unknown>): QueueItem {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    repositoryId: (row.repository_id as string | null) ?? undefined,
    jobReference: row.job_reference as string,
    requestedResourceClass: row.requested_resource_class as string,
    priority: row.priority as number,
    status: row.status as QueueItemStatus,
    attempts: row.attempts as number,
    maxAttempts: row.max_attempts as number,
    assignedRunnerId: (row.assigned_runner_id as string | null) ?? undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export interface ExecutionQueueStore {
  enqueue(input: EnqueueInput): Promise<QueueItem>;
  getItem(id: string): Promise<QueueItem | null>;
  getItemForOrganization(id: string, organizationId: string): Promise<QueueItem | null>;
  listItemsForOrganization(organizationId: string, limit?: number): Promise<QueueItem[]>;
  /** Queued items across ALL organizations, oldest-highest-priority first - the scheduler's raw input
   * before per-organization concurrency limiting is applied (Part 17, see scheduler.ts). */
  listQueuedItems(limit?: number): Promise<QueueItem[]>;
  countInFlightForOrganization(organizationId: string): Promise<number>;
  updateStatus(id: string, status: QueueItemStatus, extra?: { assignedRunnerId?: string; incrementAttempts?: boolean }): Promise<void>;
}

export function makeD1ExecutionQueueStore(db: D1Binding): ExecutionQueueStore {
  return {
    async enqueue(input) {
      const id = crypto.randomUUID();
      const ts = nowIso();
      const priority = input.priority ?? 100;
      const maxAttempts = input.maxAttempts ?? 3;
      await db
        .prepare(`INSERT INTO execution_queue_items (id, organization_id, repository_id, job_reference, requested_resource_class, priority, status, attempts, max_attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)`)
        .bind(id, input.organizationId, input.repositoryId ?? null, input.jobReference, input.requestedResourceClass, priority, maxAttempts, ts, ts)
        .run();
      return { id, organizationId: input.organizationId, repositoryId: input.repositoryId, jobReference: input.jobReference, requestedResourceClass: input.requestedResourceClass, priority, status: "queued", attempts: 0, maxAttempts, createdAt: ts, updatedAt: ts };
    },

    async getItem(id) {
      const row = await db.prepare(`SELECT * FROM execution_queue_items WHERE id = ?`).bind(id).first<Record<string, unknown>>();
      return row ? rowToQueueItem(row) : null;
    },

    async getItemForOrganization(id, organizationId) {
      const row = await db.prepare(`SELECT * FROM execution_queue_items WHERE id = ? AND organization_id = ?`).bind(id, organizationId).first<Record<string, unknown>>();
      return row ? rowToQueueItem(row) : null;
    },

    async listItemsForOrganization(organizationId, limit = 50) {
      const { results } = await db.prepare(`SELECT * FROM execution_queue_items WHERE organization_id = ? ORDER BY created_at DESC LIMIT ?`).bind(organizationId, limit).all<Record<string, unknown>>();
      return results.map(rowToQueueItem);
    },

    async listQueuedItems(limit = 200) {
      const { results } = await db.prepare(`SELECT * FROM execution_queue_items WHERE status = 'queued' ORDER BY priority ASC, created_at ASC LIMIT ?`).bind(limit).all<Record<string, unknown>>();
      return results.map(rowToQueueItem);
    },

    async countInFlightForOrganization(organizationId) {
      const row = await db
        .prepare(`SELECT COUNT(*) as n FROM execution_queue_items WHERE organization_id = ? AND status IN ('assigning', 'assigned', 'running')`)
        .bind(organizationId)
        .first<{ n: number }>();
      return row?.n ?? 0;
    },

    async updateStatus(id, status, extra) {
      const parts = ["status = ?", "updated_at = ?"];
      const values: unknown[] = [status, nowIso()];
      if (extra?.assignedRunnerId !== undefined) {
        parts.push("assigned_runner_id = ?");
        values.push(extra.assignedRunnerId);
      }
      if (extra?.incrementAttempts) {
        parts.push("attempts = attempts + 1");
      }
      values.push(id);
      await db.prepare(`UPDATE execution_queue_items SET ${parts.join(", ")} WHERE id = ?`).bind(...values).run();
    },
  };
}
