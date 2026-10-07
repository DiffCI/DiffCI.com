import assert from "node:assert/strict";
import { it } from "node:test";
import { stepPilotPacket, type PilotPacketRecord } from "../../src/analysis-fanout/cloudflare/pilot-packet-do.js";
import type { SandboxLike } from "../../src/analysis-fanout/sandbox-like.js";

const artifact = "npm:@diffci.com/diffci@0.3.9#sha512-dLfSTekU4kcmIeRnTIm16yQ7gHw+mKOFPX5lhUil/Z4fN7669HQz3zmNrOa8im57rCn3MgQEK4M2+THn24mDFw==";
function seed(): PilotPacketRecord { return { id: "job", repository: "acme/project", baseSha: "a".repeat(40), headSha: "b".repeat(40), step: "bootstrapping", sandboxId: "pilot-job", startedAt: 1, updatedAt: 1 }; }

it("runs the complete pilot packet lifecycle only through the sandbox", async () => {
  const commands: string[] = [];
  let processStatus = "running";
  const sandbox: SandboxLike = {
    async exec(command) { commands.push(command); return { success: true, exitCode: 0, stdout: "", stderr: "" }; },
    async startProcess(command) { commands.push(command); return { id: "process", status: "running" }; },
    async getProcess() { return { id: "process", status: processStatus, exitCode: processStatus === "completed" ? 0 : undefined }; },
    async readFile(path) {
      if (path.endsWith(".json")) return { content: JSON.stringify({ status: "OBSERVED" }) };
      if (path.endsWith(".md")) return { content: "# packet" };
      return { content: "name: DiffCI" };
    },
    async writeFile() { return { success: true }; }, async getProcessLogs() { return { stdout: "", stderr: "" }; },
    async killProcess() {}, async destroy() {},
  };
  const deps = { sandbox, artifact, now: () => 2 };
  let record = seed();
  ({ record } = await stepPilotPacket(record, deps)); assert.equal(record.step, "cloning");
  ({ record } = await stepPilotPacket(record, deps)); assert.equal(record.step, "analyzing");
  ({ record } = await stepPilotPacket(record, deps)); assert.equal(record.processId, "process");
  processStatus = "completed";
  ({ record } = await stepPilotPacket(record, deps)); assert.equal(record.step, "finalizing");
  ({ record } = await stepPilotPacket(record, deps)); assert.equal(record.step, "done");
  assert.deepEqual(record.observation, { status: "OBSERVED" });
  assert.ok(commands.some((command) => command.includes("npm view")));
  assert.ok(commands.some((command) => command.includes("git clone")));
  assert.ok(commands.some((command) => command.includes("pilot-packet")));
});

it("fails closed before provisioning an unpinned artifact", async () => {
  let called = false;
  const sandbox = { exec: async () => { called = true; throw new Error("unexpected"); } } as unknown as SandboxLike;
  const { record } = await stepPilotPacket(seed(), { sandbox, artifact: "@diffci.com/diffci@latest", now: () => 2 });
  assert.equal(record.step, "failed"); assert.equal(record.error, "agent-artifact-not-exactly-pinned"); assert.equal(called, false);
});

it("installs and measures paired commands inside the sandbox", async () => {
  const commands: string[] = [];
  let processStatus = "completed";
  const sandbox: SandboxLike = {
    async exec(command) { commands.push(command); return { success: true, exitCode: 0, stdout: "", stderr: "" }; },
    async startProcess(command) { commands.push(command); return { id: `process-${commands.length}`, status: "running" }; },
    async getProcess() { return { id: "process", status: processStatus, exitCode: 0 }; },
    async readFile(path) {
      if (path.endsWith("diffci-observe.json")) return { content: JSON.stringify({ status: "OBSERVED" }) };
      if (path.endsWith("diffci-savings.json")) return { content: JSON.stringify({ comparison: { evidenceValid: true } }) };
      if (path.endsWith(".md")) return { content: "# evidence" };
      return { content: "name: DiffCI" };
    },
    async writeFile() { return { success: true }; }, async getProcessLogs() { return { stdout: "", stderr: "" }; },
    async killProcess() {}, async destroy() {},
  };
  const deps = { sandbox, artifact, now: () => 2 };
  let record: PilotPacketRecord = {
    ...seed(), installCommand: "npm ci", fullCommand: "npm test",
    selectedCommand: "npm test -- changed.test.ts", cachePreparationCommand: "npm run warm-cache",
    repetitions: 1, timeoutMs: 60_000,
  };
  ({ record } = await stepPilotPacket(record, deps));
  ({ record } = await stepPilotPacket(record, deps));
  ({ record } = await stepPilotPacket(record, deps));
  ({ record } = await stepPilotPacket(record, deps)); assert.equal(record.step, "installing");
  ({ record } = await stepPilotPacket(record, deps));
  ({ record } = await stepPilotPacket(record, deps)); assert.equal(record.step, "measuring");
  ({ record } = await stepPilotPacket(record, deps));
  ({ record } = await stepPilotPacket(record, deps)); assert.equal(record.step, "finalizing");
  ({ record } = await stepPilotPacket(record, deps)); assert.equal(record.step, "done");
  assert.deepEqual(record.savings, { comparison: { evidenceValid: true } });
  assert.ok(commands.some(command => command.includes(Buffer.from("npm ci").toString("base64"))));
  const measurement = commands.find(command => command.includes("diffci pilot") && !command.includes("pilot-packet")) ?? "";
  assert.match(measurement, /--selected \"\$SELECTED\"/);
  assert.match(measurement, /--cache-prepare \"\$PREP\"/);
  assert.ok(measurement.includes(Buffer.from("npm test -- changed.test.ts").toString("base64")));
  assert.ok(measurement.includes(Buffer.from("npm run warm-cache").toString("base64")));
});

it("retains sandbox stderr when installation fails", async () => {
  const sandbox: SandboxLike = {
    async exec() { return { success: true, exitCode: 0, stdout: "", stderr: "" }; },
    async startProcess() { return { id: "install", status: "running" }; },
    async getProcess() { return { id: "install", status: "failed", exitCode: 1 }; },
    async getProcessLogs() { return { stdout: "", stderr: "npm ci requires a lockfile" }; },
    async readFile() { return { content: "" }; }, async writeFile() { return { success: true }; },
    async killProcess() {}, async destroy() {},
  };
  const deps = { sandbox, artifact, now: () => 2 };
  let record: PilotPacketRecord = { ...seed(), step: "installing", installCommand: "npm ci", fullCommand: "npm test" };
  ({ record } = await stepPilotPacket(record, deps));
  ({ record } = await stepPilotPacket(record, deps));
  assert.equal(record.step, "failed");
  assert.match(record.error ?? "", /npm ci requires a lockfile/);
});
