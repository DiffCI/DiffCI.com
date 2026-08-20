import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { EvidenceStore } from "../types.js";

/** Characters invalid in Windows/POSIX filenames within a single path segment. Deliberately excludes
 * "/" - unlike the previous implementation, path segments (split on "/") are preserved as real nested
 * directories so list(prefix) can enumerate them; only the characters that would break a single
 * segment (e.g. the ":" in a logicalDeltaKey) are replaced. */
const INVALID_SEGMENT_CHARS = /[<>:"|?*\\]/g;

export class LocalEvidenceStore implements EvidenceStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
  }

  private segments(key: string): string[] {
    return key
      .split("/")
      .filter((s) => s.length > 0)
      .map((s) => s.replace(INVALID_SEGMENT_CHARS, "_"));
  }

  private path(key: string): string {
    const segs = this.segments(key);
    if (segs.length === 0) return resolve(this.root, "_.json");
    // Callers are inconsistent about whether they include a trailing ".json" in the key itself
    // (e.g. "manifest.json" vs "repositories/owner-name"). Normalize to exactly one ".json" suffix
    // either way, so put()/get()/exists() agree regardless of caller convention, and list() can
    // always strip exactly one suffix to recover a canonical key.
    const lastRaw = segs[segs.length - 1]!;
    const fileSegment = lastRaw.endsWith(".json") ? lastRaw : `${lastRaw}.json`;
    const dirSegments = segs.slice(0, -1);
    return dirSegments.length > 0 ? resolve(this.root, ...dirSegments, fileSegment) : resolve(this.root, fileSegment);
  }

  async put(key: string, value: unknown): Promise<void> {
    const full = this.path(key);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, JSON.stringify(value, null, 2), "utf8");
  }

  async get(key: string): Promise<unknown | undefined> {
    const full = this.path(key);
    if (!existsSync(full)) return undefined;
    try {
      return JSON.parse(readFileSync(full, "utf8")) as unknown;
    } catch {
      return undefined;
    }
  }

  async exists(key: string): Promise<boolean> {
    return existsSync(this.path(key));
  }

  /** Recursively enumerates every key stored under `prefix`. Because put() sanitizes filesystem-unsafe
   * characters within each path segment (e.g. ":" -> "_"), a returned key may differ from the exact
   * original key in those characters - this is a discovery/enumeration API, not a way to recover the
   * literal original key string. Callers that need the exact record should already know the key (e.g.
   * from a manifest) and call get()/exists() directly. */
  async list(prefix: string): Promise<string[]> {
    const prefixSegments = this.segments(prefix);
    const dir = prefixSegments.length > 0 ? resolve(this.root, ...prefixSegments) : this.root;
    if (!existsSync(dir)) return [];
    const keys: string[] = [];
    const walk = (currentDir: string, relSegments: string[]) => {
      for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          walk(resolve(currentDir, entry.name), [...relSegments, entry.name]);
        } else if (entry.isFile() && entry.name.endsWith(".json")) {
          keys.push([...relSegments, entry.name.slice(0, -".json".length)].join("/"));
        }
      }
    };
    walk(dir, prefixSegments);
    return keys;
  }
}
