/**
 * Shared node:sqlite fixture helper for tests that need multiple product-layer schemas together
 * (product + billing + auth + usage + runner + execution-queue, all in the one diffci-product database
 * in production). Applies the real, committed schema.sql files in their real dependency order.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

export type SchemaModule = "product" | "billing" | "auth" | "usage" | "runner" | "execution-queue";

const SCHEMA_FILES: Record<SchemaModule, string> = {
  product: "src/product/cloudflare/schema.sql",
  billing: "src/billing/cloudflare/schema.sql",
  auth: "src/auth/cloudflare/schema.sql",
  usage: "src/usage/cloudflare/schema.sql",
  runner: "src/runner/cloudflare/schema.sql",
  "execution-queue": "src/execution-queue/cloudflare/schema.sql",
};

export function freshProductDb(modules: SchemaModule[] = ["product"]): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  // 'product' is always applied first regardless of ordering in the caller's list - every other schema
  // references organizations(id)/repositories(id).
  const ordered = ["product", ...modules.filter((m) => m !== "product")] as SchemaModule[];
  for (const m of ordered) {
    db.exec(readFileSync(join(REPO_ROOT, SCHEMA_FILES[m]), "utf8"));
  }
  return db;
}

export interface D1Like {
  prepare(query: string): {
    bind(...values: unknown[]): {
      run(): Promise<{ meta?: { changes?: number } }>;
      all<T = unknown>(): Promise<{ results: T[] }>;
      first<T = unknown>(): Promise<T | null>;
    };
  };
}

export function makeD1(db: DatabaseSync): D1Like {
  return {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async run() {
              const result = db.prepare(query).run(...(values as never[]));
              return { meta: { changes: Number(result.changes) } };
            },
            async all<T = unknown>() {
              const rows = db.prepare(query).all(...(values as never[]));
              return { results: rows as T[] };
            },
            async first<T = unknown>() {
              const row = db.prepare(query).get(...(values as never[]));
              return (row ?? null) as T | null;
            },
          };
        },
      };
    },
  };
}
