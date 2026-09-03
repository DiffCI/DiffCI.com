import type { EvidenceStore } from "../types.js";

export interface R2Binding {
  // json/arrayBuffer are both on the real R2ObjectBody - arrayBuffer is used for the binary shadow
  // source tarball (validation-worker.ts's shadow-cron wiring), json for all evidence records.
  get(key: string): Promise<{ json<T>(): Promise<T>; arrayBuffer(): Promise<ArrayBuffer> } | null>;
  put(key: string, value: string | ArrayBuffer): Promise<void>;
  list(options?: { prefix?: string }): Promise<{ objects: { key: string }[] }>;
  /** Existence/metadata check without downloading the body - the real R2Bucket supports this natively.
   * Optional (not every fake in the test suite implements it) - callers that need it fall back to a
   * full get() when absent, see R2EvidenceStore.headExists. */
  head?(key: string): Promise<unknown | null>;
  /** Batch delete - the real R2Bucket accepts up to 1000 keys per call. Optional, added for
   * site/data-handling.html's erasure commitments (shadow-erasure.ts) - most fakes in the test suite
   * never needed to delete anything before that. Absence is NOT treated as "nothing to delete" by
   * R2EvidenceStore.deleteMany, which throws instead: a binding that silently can't erase must never be
   * mistaken for one that erased successfully. */
  delete?(keys: string[]): Promise<void>;
}

export class R2EvidenceStore implements EvidenceStore {
  private readonly bucket: R2Binding;

  constructor(bucket: R2Binding) {
    this.bucket = bucket;
  }

  async put(key: string, value: unknown): Promise<void> {
    await this.bucket.put(key, JSON.stringify(value));
  }

  async get(key: string): Promise<unknown | undefined> {
    const obj = await this.bucket.get(key);
    if (!obj) return undefined;
    return obj.json<unknown>();
  }

  async exists(key: string): Promise<boolean> {
    const obj = await this.bucket.get(key);
    return obj !== null;
  }

  /** Existence-only check, cheap even for a multi-MB object (the shadow source archive) - uses head()
   * when the binding supports it, otherwise falls back to a full get() so this stays correct against
   * any fake/binding that only implements the minimal R2Binding surface. */
  async headExists(key: string): Promise<boolean> {
    if (this.bucket.head) return (await this.bucket.head(key)) !== null;
    return this.exists(key);
  }

  async list(prefix: string): Promise<string[]> {
    const result = await this.bucket.list({ prefix });
    return result.objects.map((o) => o.key);
  }

  /** Erasure - site/data-handling.html's "Uninstalling deletes it" and "90 days maximum, regardless"
   * (shadow-erasure.ts calls this after reading the keys it needs to delete out of D1, before deleting
   * the D1 rows that named them). Chunked at 500 - comfortably under the real R2Bucket's 1000-key
   * per-call limit, without relying on that ceiling never moving. Throws if the binding cannot delete at
   * all, rather than silently reporting success for zero real deletions - see R2Binding.delete's comment. */
  async deleteMany(keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    if (!this.bucket.delete) throw new Error("R2Binding.delete is not implemented - cannot honor an erasure request");
    const CHUNK = 500;
    for (let i = 0; i < keys.length; i += CHUNK) {
      await this.bucket.delete(keys.slice(i, i + CHUNK));
    }
    return keys.length;
  }
}
