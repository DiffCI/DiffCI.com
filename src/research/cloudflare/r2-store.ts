import type { EvidenceStore } from "../types.js";

export interface R2Binding {
  get(key: string): Promise<{ json<T>(): Promise<T> } | null>;
  put(key: string, value: string | ArrayBuffer): Promise<void>;
  list(options?: { prefix?: string }): Promise<{ objects: { key: string }[] }>;
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

  async list(prefix: string): Promise<string[]> {
    const result = await this.bucket.list({ prefix });
    return result.objects.map((o) => o.key);
  }
}
