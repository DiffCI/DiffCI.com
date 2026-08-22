/**
 * Product control-plane domain types: User -> Organization -> Repository, per the SaaS build-phase
 * spec's preferred hierarchy (Part 2). Deliberately separate from src/repo/types.ts (the dependency-graph
 * engine's RepositoryProfile) and from shadow_repositories (src/research/cloudflare/shadow-store.ts,
 * Stage 2's globally-keyed, org-less enrollment table) - this module owns the multi-tenant account model,
 * neither of the other two.
 */

export interface User {
  id: string;
  email: string;
  name?: string;
  createdAt: string;
  updatedAt: string;
}

/** Kept intentionally small (Part 2: "avoid designing a huge RBAC system yet"). */
export type OrganizationRole = "owner" | "admin" | "member";

/**
 * `billingStatus` is DiffCI's own internal mapping (see src/billing/types.ts SubscriptionStatus for how a
 * provider's raw subscription status maps down to this), not a raw copy of the billing provider's status
 * string - `subscriptionStatus` carries that for debugging. `currentPlan` is always an internal plan id
 * (src/billing/plans.ts), never a billing-provider variant id.
 */
export interface Organization {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
  billingStatus: "none" | "trialing" | "active" | "past_due" | "cancelled" | "expired";
  billingCustomerReference?: string;
  currentPlan: string;
  subscriptionStatus?: string;
}

export interface OrganizationMember {
  organizationId: string;
  userId: string;
  role: OrganizationRole;
  createdAt: string;
}

/**
 * An internal DiffCI repository record, deliberately not a mirror of GitHub's own repository payload
 * (Part 2). `shadowEnabled` is a pointer/flag into the separate, pre-existing shadow_repositories table
 * (keyed by "owner/name", no org concept) - this record never duplicates shadow state, only references
 * whether shadow observation has been turned on for it.
 */
export interface Repository {
  id: string;
  organizationId: string;
  provider: "github";
  providerRepositoryId: string;
  ownerName: string; // "owner/name" - display/lookup convenience, may go stale on a GitHub-side rename
  defaultBranch: string;
  installationId?: string;
  status: "pending" | "active" | "paused" | "removed";
  shadowEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AuditLogEntry {
  id: string;
  organizationId?: string;
  actorUserId?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}
