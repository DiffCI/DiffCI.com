/**
 * Minimal structural typing for the Sandbox container surface the AnalysisShard DO depends on
 * (2026-08-23).
 *
 * This deliberately does NOT import `@cloudflare/sandbox` at type level: the AnalysisShard Durable
 * Object is driven through an injectable factory so the state machine can be tested with a stub (no
 * network, no real container) exactly like `tests/runner/*.test.ts` stub their providers. In production
 * the factory is `getSandbox(env.ANALYSIS_SHARD_CONTAINER, id, opts)`; in tests it is a fake.
 */

export interface ExecResultLike {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ProcessLike {
  id: string;
  status: string;
  exitCode?: number;
}

export interface SandboxLike {
  exec(command: string, options?: { timeout?: number; cwd?: string }): Promise<ExecResultLike>;
  writeFile(
    path: string,
    content: string | ReadableStream<Uint8Array>,
    options?: { encoding?: string },
  ): Promise<{ success: boolean; path?: string; exitCode?: number }>;
  readFile(path: string): Promise<{ content: string }>;
  startProcess(command: string, options?: { cwd?: string; autoCleanup?: boolean }): Promise<ProcessLike>;
  getProcess(id: string): Promise<ProcessLike | null>;
  destroy(): Promise<void>;
}

/** Minimal R2 structural typing (this project does not depend on @cloudflare/workers-types). */
export interface R2ObjectBodyLike {
  key: string;
  size: number;
  body: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

export interface R2BucketLike {
  get(key: string): Promise<R2ObjectBodyLike | null>;
  put(key: string, value: string | ArrayBuffer | Uint8Array | ReadableStream): Promise<unknown>;
}