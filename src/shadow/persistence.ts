import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import type { BenchmarkRun, ShadowRunRecord } from "./types.js";
import { validateShadowRunRecord } from "./record-validation.js";

const CURRENT_SCHEMA = "diffci-shadow/1";

export interface PersistenceOptions {
  directory: string;
}

export class DiffCiPersistence {
  private readonly options: PersistenceOptions;

  constructor(options: PersistenceOptions) {
    this.options = options;
  }

  private shadowPath(): string {
    return `${this.options.directory}/shadow-runs.jsonl`;
  }

  private benchmarkPath(): string {
    return `${this.options.directory}/benchmark-runs.jsonl`;
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.shadowPath()), { recursive: true });
  }

  recordShadow(run: ShadowRunRecord): void {
    const validation = validateShadowRunRecord(run);
    const payload = validation.valid
      ? { schema: CURRENT_SCHEMA, ...run }
      : { schema: CURRENT_SCHEMA, ...run, _validationErrors: validation.errors };
    appendFileSync(this.shadowPath(), JSON.stringify(payload) + "\n");
  }

  recordBenchmark(run: BenchmarkRun): void {
    appendFileSync(this.benchmarkPath(), JSON.stringify({ schema: CURRENT_SCHEMA, ...run }) + "\n");
  }

  private parseLines<T>(path: string): { valid: T[]; malformed: unknown[] } {
    if (!existsSync(path)) return { valid: [], malformed: [] };
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    const valid: T[] = [];
    const malformed: unknown[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (Array.isArray(parsed._validationErrors) && parsed._validationErrors.length > 0) {
          malformed.push(parsed);
        } else {
          valid.push(parsed as T);
        }
      } catch {
        malformed.push(line);
      }
    }
    return { valid, malformed };
  }

  readShadowRuns(): { valid: ShadowRunRecord[]; malformed: unknown[] } {
    return this.parseLines<ShadowRunRecord>(this.shadowPath());
  }

  readBenchmarkRuns(): BenchmarkRun[] {
    if (!existsSync(this.benchmarkPath())) return [];
    const lines = readFileSync(this.benchmarkPath(), "utf8").split("\n").filter(Boolean);
    return lines.map((line) => JSON.parse(line) as BenchmarkRun);
  }

  writeReport(path: string, report: unknown): void {
    writeFileSync(path, JSON.stringify(report, null, 2));
  }
}

export function currentSchema(): string {
  return CURRENT_SCHEMA;
}
