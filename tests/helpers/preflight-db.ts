/**
 * node:sqlite fixture helper for Preflight P1's own, structurally separate D1 database
 * (src/preflight/cloudflare/schema.sql) - the same real-SQLite-execution pattern
 * tests/helpers/product-db.ts uses for the product-layer schemas, kept as its own file rather than
 * extending that one, matching this module tree's deliberate storage/infra separation from the rest
 * of the product (see src/preflight/cloudflare/schema.sql's own header comment).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { D1Binding } from "../../src/preflight/cloudflare/d1-prediction-store.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

export function freshPreflightDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(join(REPO_ROOT, "src/preflight/cloudflare/schema.sql"), "utf8"));
  return db;
}

export function makeD1(db: DatabaseSync): D1Binding {
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
