/**
 * D1 persistence for the product control plane (users/organizations/organization_members/repositories/
 * audit_log - src/product/cloudflare/schema.sql). Same idiom as src/research/cloudflare/shadow-store.ts:
 * a duplicated minimal D1Binding shape (independently importable/testable without pulling in a Worker
 * file), plain prepared statements, no ORM (matches the rest of the codebase - see the architecture audit,
 * no query builder is used anywhere today).
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

import type { AuditLogEntry, Organization, OrganizationMember, OrganizationRole, Repository, User } from "./types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  return crypto.randomUUID();
}

function rowToUser(row: Record<string, unknown>): User {
  return {
    id: row.id as string,
    email: row.email as string,
    name: (row.name as string | null) ?? undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function rowToOrganization(row: Record<string, unknown>): Organization {
  return {
    id: row.id as string,
    name: row.name as string,
    slug: row.slug as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    billingStatus: row.billing_status as Organization["billingStatus"],
    billingCustomerReference: (row.billing_customer_reference as string | null) ?? undefined,
    currentPlan: row.current_plan as string,
    subscriptionStatus: (row.subscription_status as string | null) ?? undefined,
  };
}

function rowToRepository(row: Record<string, unknown>): Repository {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    provider: row.provider as "github",
    providerRepositoryId: row.provider_repository_id as string,
    ownerName: row.owner_name as string,
    defaultBranch: row.default_branch as string,
    installationId: (row.installation_id as string | null) ?? undefined,
    status: row.status as Repository["status"],
    shadowEnabled: Boolean(row.shadow_enabled),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export interface ProductStore {
  createUser(input: { email: string; name?: string }): Promise<User>;
  getUser(id: string): Promise<User | null>;
  getUserByEmail(email: string): Promise<User | null>;

  createOrganization(input: { name: string; slug: string; ownerUserId: string }): Promise<Organization>;
  getOrganization(id: string): Promise<Organization | null>;
  getOrganizationBySlug(slug: string): Promise<Organization | null>;
  updateOrganizationBilling(
    id: string,
    input: { billingStatus: Organization["billingStatus"]; currentPlan?: string; subscriptionStatus?: string; billingCustomerReference?: string },
  ): Promise<void>;

  addMember(organizationId: string, userId: string, role: OrganizationRole): Promise<void>;
  getMembership(organizationId: string, userId: string): Promise<OrganizationMember | null>;
  listMembers(organizationId: string): Promise<OrganizationMember[]>;
  /** Returns true iff userId belongs to organizationId with ANY role - the tenant-isolation primitive
   * every organization-scoped route (Part 17/19) must call before touching that org's data. */
  isMember(organizationId: string, userId: string): Promise<boolean>;

  createRepository(input: {
    organizationId: string;
    providerRepositoryId: string;
    ownerName: string;
    defaultBranch?: string;
    installationId?: string;
  }): Promise<Repository>;
  getRepository(id: string): Promise<Repository | null>;
  listRepositories(organizationId: string): Promise<Repository[]>;
  /** Cross-tenant, NOT organization-scoped - same pattern as RunnerStore.findStaleRunners(), used only by
   * background maintenance sweeps (src/usage/duration-capture-job.ts's cron caller), never by an
   * organization-facing route (which must always go through the scoped listRepositories above). */
  listAllRepositories(limit?: number): Promise<Repository[]>;
  setRepositoryStatus(id: string, status: Repository["status"]): Promise<void>;
  setRepositoryShadowEnabled(id: string, enabled: boolean): Promise<void>;

  /** Part 19 audit trail. metadata must already be scrubbed of secrets by the caller - this store never
   * inspects or redacts it. */
  recordAuditEvent(entry: Omit<AuditLogEntry, "id" | "createdAt">): Promise<void>;
  listAuditEvents(organizationId: string, limit?: number): Promise<AuditLogEntry[]>;
}

export function makeD1ProductStore(db: D1Binding): ProductStore {
  return {
    async createUser({ email, name }) {
      const id = newId();
      const ts = nowIso();
      await db
        .prepare(`INSERT INTO users (id, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
        .bind(id, email, name ?? null, ts, ts)
        .run();
      return { id, email, name, createdAt: ts, updatedAt: ts };
    },

    async getUser(id) {
      const row = await db.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first<Record<string, unknown>>();
      return row ? rowToUser(row) : null;
    },

    async getUserByEmail(email) {
      const row = await db.prepare(`SELECT * FROM users WHERE email = ?`).bind(email).first<Record<string, unknown>>();
      return row ? rowToUser(row) : null;
    },

    async createOrganization({ name, slug, ownerUserId }) {
      const id = newId();
      const ts = nowIso();
      await db
        .prepare(
          `INSERT INTO organizations (id, name, slug, created_at, updated_at, billing_status, current_plan)
           VALUES (?, ?, ?, ?, ?, 'none', 'free')`,
        )
        .bind(id, name, slug, ts, ts)
        .run();
      await db
        .prepare(`INSERT INTO organization_members (organization_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)`)
        .bind(id, ownerUserId, ts)
        .run();
      return { id, name, slug, createdAt: ts, updatedAt: ts, billingStatus: "none", currentPlan: "free" };
    },

    async getOrganization(id) {
      const row = await db.prepare(`SELECT * FROM organizations WHERE id = ?`).bind(id).first<Record<string, unknown>>();
      return row ? rowToOrganization(row) : null;
    },

    async getOrganizationBySlug(slug) {
      const row = await db.prepare(`SELECT * FROM organizations WHERE slug = ?`).bind(slug).first<Record<string, unknown>>();
      return row ? rowToOrganization(row) : null;
    },

    async updateOrganizationBilling(id, { billingStatus, currentPlan, subscriptionStatus, billingCustomerReference }) {
      await db
        .prepare(
          `UPDATE organizations SET
             billing_status = ?,
             current_plan = COALESCE(?, current_plan),
             subscription_status = COALESCE(?, subscription_status),
             billing_customer_reference = COALESCE(?, billing_customer_reference),
             updated_at = ?
           WHERE id = ?`,
        )
        .bind(billingStatus, currentPlan ?? null, subscriptionStatus ?? null, billingCustomerReference ?? null, nowIso(), id)
        .run();
    },

    async addMember(organizationId, userId, role) {
      await db
        .prepare(
          `INSERT INTO organization_members (organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (organization_id, user_id) DO UPDATE SET role = excluded.role`,
        )
        .bind(organizationId, userId, role, nowIso())
        .run();
    },

    async getMembership(organizationId, userId) {
      const row = await db
        .prepare(`SELECT * FROM organization_members WHERE organization_id = ? AND user_id = ?`)
        .bind(organizationId, userId)
        .first<Record<string, unknown>>();
      if (!row) return null;
      return {
        organizationId: row.organization_id as string,
        userId: row.user_id as string,
        role: row.role as OrganizationRole,
        createdAt: row.created_at as string,
      };
    },

    async listMembers(organizationId) {
      const { results } = await db
        .prepare(`SELECT * FROM organization_members WHERE organization_id = ?`)
        .bind(organizationId)
        .all<Record<string, unknown>>();
      return results.map((row) => ({
        organizationId: row.organization_id as string,
        userId: row.user_id as string,
        role: row.role as OrganizationRole,
        createdAt: row.created_at as string,
      }));
    },

    async isMember(organizationId, userId) {
      const row = await db
        .prepare(`SELECT 1 as present FROM organization_members WHERE organization_id = ? AND user_id = ?`)
        .bind(organizationId, userId)
        .first<{ present: number }>();
      return row !== null;
    },

    async createRepository({ organizationId, providerRepositoryId, ownerName, defaultBranch, installationId }) {
      const id = newId();
      const ts = nowIso();
      await db
        .prepare(
          `INSERT INTO repositories
             (id, organization_id, provider, provider_repository_id, owner_name, default_branch,
              installation_id, status, shadow_enabled, created_at, updated_at)
           VALUES (?, ?, 'github', ?, ?, ?, ?, 'pending', 0, ?, ?)`,
        )
        .bind(id, organizationId, providerRepositoryId, ownerName, defaultBranch ?? "main", installationId ?? null, ts, ts)
        .run();
      return {
        id,
        organizationId,
        provider: "github",
        providerRepositoryId,
        ownerName,
        defaultBranch: defaultBranch ?? "main",
        installationId,
        status: "pending",
        shadowEnabled: false,
        createdAt: ts,
        updatedAt: ts,
      };
    },

    async getRepository(id) {
      const row = await db.prepare(`SELECT * FROM repositories WHERE id = ?`).bind(id).first<Record<string, unknown>>();
      return row ? rowToRepository(row) : null;
    },

    async listRepositories(organizationId) {
      const { results } = await db
        .prepare(`SELECT * FROM repositories WHERE organization_id = ? ORDER BY created_at DESC`)
        .bind(organizationId)
        .all<Record<string, unknown>>();
      return results.map(rowToRepository);
    },

    async listAllRepositories(limit = 100) {
      const { results } = await db.prepare(`SELECT * FROM repositories ORDER BY created_at DESC LIMIT ?`).bind(limit).all<Record<string, unknown>>();
      return results.map(rowToRepository);
    },

    async setRepositoryStatus(id, status) {
      await db.prepare(`UPDATE repositories SET status = ?, updated_at = ? WHERE id = ?`).bind(status, nowIso(), id).run();
    },

    async setRepositoryShadowEnabled(id, enabled) {
      await db
        .prepare(`UPDATE repositories SET shadow_enabled = ?, updated_at = ? WHERE id = ?`)
        .bind(enabled ? 1 : 0, nowIso(), id)
        .run();
    },

    async recordAuditEvent(entry) {
      await db
        .prepare(
          `INSERT INTO audit_log (id, organization_id, actor_user_id, action, target_type, target_id, metadata, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          newId(),
          entry.organizationId ?? null,
          entry.actorUserId ?? null,
          entry.action,
          entry.targetType ?? null,
          entry.targetId ?? null,
          entry.metadata ? JSON.stringify(entry.metadata) : null,
          nowIso(),
        )
        .run();
    },

    async listAuditEvents(organizationId, limit = 100) {
      const { results } = await db
        .prepare(`SELECT * FROM audit_log WHERE organization_id = ? ORDER BY created_at DESC LIMIT ?`)
        .bind(organizationId, limit)
        .all<Record<string, unknown>>();
      return results.map((row) => ({
        id: row.id as string,
        organizationId: (row.organization_id as string | null) ?? undefined,
        actorUserId: (row.actor_user_id as string | null) ?? undefined,
        action: row.action as string,
        targetType: (row.target_type as string | null) ?? undefined,
        targetId: (row.target_id as string | null) ?? undefined,
        metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
        createdAt: row.created_at as string,
      }));
    },
  };
}
