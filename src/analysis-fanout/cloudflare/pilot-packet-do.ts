import type { SandboxLike } from "../sandbox-like.js";

export type PilotPacketStep = "bootstrapping" | "cloning" | "analyzing" | "installing" | "measuring" | "finalizing" | "done" | "failed" | "cancelled";
export interface PilotPacketRecord {
  id: string; repository: string; baseSha: string; headSha: string; step: PilotPacketStep;
  sandboxId: string; processId?: string; startedAt: number; updatedAt: number; error?: string;
  installCommand?: string; fullCommand?: string; repetitions?: number; timeoutMs?: number;
  observation?: unknown; packet?: string; workflow?: string; savings?: unknown; savingsMarkdown?: string;
}
export interface PilotPacketDeps { sandbox: SandboxLike; artifact: string; now(): number }

const TERMINAL = new Set<PilotPacketStep>(["done", "failed", "cancelled"]);
const POLL_MS = 10_000;
const MAX_ARTIFACT_BYTES = 512 * 1024;
const OPTIONS = { enableDefaultSession: false, keepAlive: false, sleepAfter: "10m", transport: "rpc" } as const;

function fail(record: PilotPacketRecord, error: string): { record: PilotPacketRecord; nextAlarmDelayMs: null } {
  record.step = "failed"; record.error = error.slice(0, 1000); return { record, nextAlarmDelayMs: null };
}
function artifactParts(value: string): { spec: string; integrity: string } | null {
  const match = /^npm:(@diffci\.com\/diffci@(\d+\.\d+\.\d+))#(sha512-[A-Za-z0-9+/=]+)$/.exec(value);
  return match ? { spec: match[1]!, integrity: match[3]! } : null;
}
function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function decodedShell(command: string): string {
  return `printf %s '${base64(command)}' | base64 -d | bash`;
}

export async function stepPilotPacket(record: PilotPacketRecord, deps: PilotPacketDeps): Promise<{ record: PilotPacketRecord; nextAlarmDelayMs: number | null }> {
  record.updatedAt = deps.now();
  try {
    if (record.step === "bootstrapping") {
      const artifact = artifactParts(deps.artifact);
      if (!artifact) return fail(record, "agent-artifact-not-exactly-pinned");
      await deps.sandbox.exec("rm -rf /opt/pilot /workspace && mkdir -p /opt/pilot /workspace", { timeout: 30_000 });
      const check = await deps.sandbox.exec(
        "actual=$(npm view \"$DIFFCI_SPEC\" dist.integrity); test \"$actual\" = \"$DIFFCI_INTEGRITY\" && npm install --prefix /opt/pilot --ignore-scripts --no-audit --no-fund \"$DIFFCI_SPEC\"",
        { timeout: 10 * 60_000, env: { DIFFCI_SPEC: artifact.spec, DIFFCI_INTEGRITY: artifact.integrity } },
      );
      if (!check.success) return fail(record, `bootstrap-failed:${check.exitCode}`);
      record.step = "cloning"; return { record, nextAlarmDelayMs: 0 };
    }
    if (record.step === "cloning") {
      const clone = await deps.sandbox.exec(
        "git clone --quiet --filter=blob:none \"https://github.com/$DIFFCI_REPOSITORY.git\" /workspace/repo && cd /workspace/repo && git checkout --quiet --force --detach \"$DIFFCI_HEAD\" && git cat-file -e \"$DIFFCI_BASE^{commit}\"",
        { timeout: 20 * 60_000, env: { DIFFCI_REPOSITORY: record.repository, DIFFCI_HEAD: record.headSha, DIFFCI_BASE: record.baseSha } },
      );
      if (!clone.success) return fail(record, `clone-or-revision-failed:${clone.exitCode}`);
      record.step = "analyzing"; return { record, nextAlarmDelayMs: 0 };
    }
    if (record.step === "analyzing") {
      if (!record.processId) {
        const process = await deps.sandbox.startProcess(
          `/opt/pilot/node_modules/.bin/diffci pilot-packet --repo /workspace/repo --out-dir /workspace/output --base "${record.baseSha}" --head "${record.headSha}" --label "${record.repository}" --repository-url "https://github.com/${record.repository}"`,
          { cwd: "/workspace", autoCleanup: false },
        );
        record.processId = process.id; return { record, nextAlarmDelayMs: POLL_MS };
      }
      const process = await deps.sandbox.getProcess(record.processId);
      if (!process || ["failed", "killed", "error"].includes(process.status)) return fail(record, `analysis-failed:${process?.exitCode ?? "missing"}`);
      if (process.status !== "completed") return { record, nextAlarmDelayMs: POLL_MS };
      if (process.exitCode !== 0) return fail(record, `analysis-exit:${process.exitCode}`);
      record.processId = undefined;
      record.step = record.installCommand && record.fullCommand ? "installing" : "finalizing";
      return { record, nextAlarmDelayMs: 0 };
    }
    if (record.step === "installing") {
      if (!record.processId) {
        const seconds = Math.ceil((record.timeoutMs ?? 30 * 60_000) / 1000);
        const process = await deps.sandbox.startProcess(`timeout ${seconds}s bash -lc "${decodedShell(record.installCommand!)}"`, { cwd: "/workspace/repo", autoCleanup: false });
        record.processId = process.id; return { record, nextAlarmDelayMs: POLL_MS };
      }
      const process = await deps.sandbox.getProcess(record.processId);
      if (!process || ["failed", "killed", "error"].includes(process.status)) return fail(record, `install-failed:${process?.exitCode ?? "missing"}`);
      if (process.status !== "completed") return { record, nextAlarmDelayMs: POLL_MS };
      if (process.exitCode !== 0) return fail(record, `install-exit:${process.exitCode}`);
      record.processId = undefined; record.step = "measuring"; return { record, nextAlarmDelayMs: 0 };
    }
    if (record.step === "measuring") {
      if (!record.processId) {
        const timeoutMs = record.timeoutMs ?? 30 * 60_000;
        const seconds = Math.ceil((timeoutMs * 2 * (record.repetitions ?? 1) + 5 * 60_000) / 1000);
        const full = base64(record.fullCommand!);
        const command = `FULL=$(printf %s '${full}' | base64 -d); timeout ${seconds}s /opt/pilot/node_modules/.bin/diffci pilot --repo /workspace/repo --out-dir /workspace/paired --base "${record.baseSha}" --head "${record.headSha}" --label "${record.repository}" --full "$FULL" --timeout-ms "${timeoutMs}" --repetitions "${record.repetitions ?? 1}"`;
        const process = await deps.sandbox.startProcess(command, { cwd: "/workspace", autoCleanup: false });
        record.processId = process.id; return { record, nextAlarmDelayMs: POLL_MS };
      }
      const process = await deps.sandbox.getProcess(record.processId);
      if (!process || ["killed", "error"].includes(process.status)) return fail(record, `measurement-failed:${process?.exitCode ?? "missing"}`);
      if (process.status !== "completed" && process.status !== "failed") return { record, nextAlarmDelayMs: POLL_MS };
      record.processId = undefined; record.step = "finalizing"; return { record, nextAlarmDelayMs: 0 };
    }
    if (record.step === "finalizing") {
      const [observation, packet, workflow] = await Promise.all([
        deps.sandbox.readFile("/workspace/output/diffci-observe.json"),
        deps.sandbox.readFile("/workspace/output/pilot-packet.md"),
        deps.sandbox.readFile("/workspace/output/diffci-observe.yml"),
      ]);
      if ([observation.content, packet.content, workflow.content].some((value) => new TextEncoder().encode(value).length > MAX_ARTIFACT_BYTES)) return fail(record, "artifact-too-large");
      record.observation = JSON.parse(observation.content); record.packet = packet.content; record.workflow = workflow.content;
      if (record.fullCommand) {
        const [savings, markdown] = await Promise.all([
          deps.sandbox.readFile("/workspace/paired/diffci-savings.json"),
          deps.sandbox.readFile("/workspace/paired/diffci-savings.md"),
        ]);
        if ([savings.content, markdown.content].some(value => new TextEncoder().encode(value).length > MAX_ARTIFACT_BYTES)) return fail(record, "paired-artifact-too-large");
        record.savings = JSON.parse(savings.content); record.savingsMarkdown = markdown.content;
      }
      record.step = "done"; return { record, nextAlarmDelayMs: null };
    }
    return { record, nextAlarmDelayMs: null };
  } catch (error) { return fail(record, error instanceof Error ? error.message : String(error)); }
}

interface Storage { get<T>(key: string): Promise<T | undefined>; put<T>(key: string, value: T): Promise<void>; setAlarm(at: number): Promise<void>; deleteAlarm(): Promise<void> }
interface State { storage: Storage }
interface Env { ANALYSIS_SHARD_CONTAINER: any; DIFFCI_AGENT_ARTIFACT?: string }
export class PilotPacketJob {
  constructor(private state: State, private env: Env) {}
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/start") {
      const seed = await request.json() as PilotPacketRecord;
      const existing = await this.state.storage.get<PilotPacketRecord>("record");
      if (existing) return Response.json(existing);
      await this.state.storage.put("record", seed); await this.state.storage.setAlarm(Date.now() + 1000); return Response.json(seed, { status: 202 });
    }
    const record = await this.state.storage.get<PilotPacketRecord>("record");
    if (request.method === "GET" && path === "/state") return record ? Response.json(record) : Response.json({ error: "not-found" }, { status: 404 });
    if (request.method === "POST" && path === "/cancel" && record && !TERMINAL.has(record.step)) { record.step = "cancelled"; await this.state.storage.put("record", record); await this.state.storage.deleteAlarm(); return Response.json(record); }
    return Response.json({ error: "not-found" }, { status: 404 });
  }
  async alarm(): Promise<void> {
    const record = await this.state.storage.get<PilotPacketRecord>("record"); if (!record || TERMINAL.has(record.step)) return;
    const { getSandbox } = await import("@cloudflare/sandbox");
    const sandbox: SandboxLike = getSandbox(this.env.ANALYSIS_SHARD_CONTAINER, record.sandboxId, OPTIONS);
    const result = await stepPilotPacket(record, { sandbox, artifact: this.env.DIFFCI_AGENT_ARTIFACT ?? "", now: () => Date.now() });
    await this.state.storage.put("record", result.record);
    if (result.nextAlarmDelayMs === null) { await this.state.storage.deleteAlarm(); try { await sandbox.destroy(); } catch {} }
    else await this.state.storage.setAlarm(Date.now() + result.nextAlarmDelayMs);
  }
}
