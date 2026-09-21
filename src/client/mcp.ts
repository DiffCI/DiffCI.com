#!/usr/bin/env node
import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
}

interface ToolCallParams {
  name?: string;
  arguments?: Record<string, unknown>;
}

const SERVER_INFO = { name: "diffci-mcp", version: "0.1.0" };

const tools = [
  {
    name: "diffci_check",
    description: "Run DiffCI's observation-only AI-agent validation command. It sends nothing by default and does not run, skip, cancel, or reorder tests.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repository path. Defaults to the MCP server working directory." },
        base: { type: "string", description: "Optional base commit SHA." },
        head: { type: "string", description: "Optional head commit SHA." },
        json: { type: "boolean", description: "Print the full JSON observation report." },
        quiet: { type: "boolean", description: "Suppress the human summary." },
        redactPaths: { type: "boolean", description: "Replace paths with stable digests in the report." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "diffci_init",
    description: "Seed a repository with AI-agent instruction files for DiffCI.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repository path. Defaults to the MCP server working directory." },
        workflow: { type: "boolean", description: "Also add the non-blocking GitHub Actions observer workflow." },
        force: { type: "boolean", description: "Overwrite existing instruction files." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "diffci_verify_workflow",
    description: "Check that a DiffCI GitHub Actions job cannot affect the rest of CI.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repository path. Defaults to the MCP server working directory." },
      },
      additionalProperties: false,
    },
  },
];

function cliPath(): string {
  return join(dirname(import.meta.filename), "cli.js");
}

function stringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function booleanArg(args: Record<string, unknown>, name: string): boolean {
  return args[name] === true;
}

function commandForTool(name: string, args: Record<string, unknown>): string[] {
  const repo = stringArg(args, "repo");
  switch (name) {
    case "diffci_check": {
      const command = ["check"];
      if (repo) command.push("--repo", resolve(repo));
      for (const flag of ["base", "head"]) {
        const value = stringArg(args, flag);
        if (value) command.push(`--${flag}`, value);
      }
      if (booleanArg(args, "json")) command.push("--json");
      if (booleanArg(args, "quiet")) command.push("--quiet");
      if (booleanArg(args, "redactPaths")) command.push("--redact-paths");
      return command;
    }
    case "diffci_init": {
      const command = ["init"];
      if (repo) command.push("--repo", resolve(repo));
      if (booleanArg(args, "workflow")) command.push("--workflow");
      if (booleanArg(args, "force")) command.push("--force");
      return command;
    }
    case "diffci_verify_workflow": {
      const command = ["verify-workflow"];
      if (repo) command.push("--repo", resolve(repo));
      return command;
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    execFile(process.execPath, [cliPath(), ...args], {
      cwd: process.cwd(),
      env: { ...process.env, DIFFCI_MCP: "1" },
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      const exitCode = typeof code === "number" ? code : error ? 1 : 0;
      resolveRun({ exitCode, stdout, stderr });
    });
  });
}

function writeMessage(message: unknown): void {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

function success(id: JsonRpcId | undefined, result: unknown): void {
  if (id === undefined) return;
  writeMessage({ jsonrpc: "2.0", id, result });
}

function failure(id: JsonRpcId | undefined, code: number, message: string): void {
  if (id === undefined) return;
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(request: JsonRpcRequest): Promise<void> {
  const id = request.id;
  switch (request.method) {
    case "initialize":
      success(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;
    case "notifications/initialized":
      return;
    case "tools/list":
      success(id, { tools });
      return;
    case "tools/call": {
      const params = request.params as ToolCallParams | undefined;
      if (!params?.name) {
        failure(id, -32602, "tools/call requires params.name");
        return;
      }
      const args = params.arguments ?? {};
      const run = await runCli(commandForTool(params.name, args));
      const text = [
        run.stdout.trim(),
        run.stderr.trim() ? `stderr:\n${run.stderr.trim()}` : "",
        `exitCode: ${run.exitCode}`,
      ].filter(Boolean).join("\n\n");
      success(id, {
        content: [{ type: "text", text }],
        isError: run.exitCode !== 0,
      });
      return;
    }
    default:
      failure(id, -32601, `unknown method: ${request.method ?? ""}`);
  }
}

let buffer = Buffer.alloc(0);
const decoder = new StringDecoder("utf8");

function readMessages(): void {
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const header = decoder.write(buffer.subarray(0, headerEnd));
    const match = /^Content-Length:\s*(\d+)\s*$/im.exec(header);
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) return;
    const body = buffer.subarray(bodyStart, bodyEnd).toString("utf8");
    buffer = buffer.subarray(bodyEnd);
    const request = JSON.parse(body) as JsonRpcRequest;
    void handle(request).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      failure(request.id, -32603, message);
    });
  }
}

process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  readMessages();
});

process.stdin.resume();
