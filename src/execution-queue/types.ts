export type QueueItemStatus = "queued" | "assigning" | "assigned" | "running" | "completed" | "failed" | "cancelled" | "timed_out";

export interface QueueItem {
  id: string;
  organizationId: string;
  repositoryId?: string;
  jobReference: string; // opaque - identifies the underlying unit of work (e.g. a synthetic test job id)
  requestedResourceClass: string;
  priority: number; // lower = higher priority, matching most scheduler conventions
  status: QueueItemStatus;
  attempts: number;
  maxAttempts: number;
  assignedRunnerId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueInput {
  organizationId: string;
  repositoryId?: string;
  jobReference: string;
  requestedResourceClass: string;
  priority?: number;
  maxAttempts?: number;
}
