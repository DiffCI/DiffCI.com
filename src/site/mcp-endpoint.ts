/**
 * Stateless, public MCP endpoint for diffci.com.
 *
 * The site Worker deliberately has no repository, secret, or product-service bindings. The HTTPS
 * endpoint therefore exposes setup/validation guidance, while the stdio server remains the transport
 * that can inspect and execute against a caller's local checkout.
 */

import { interpretObservationReport, verifyWorkflowText } from "./mcp-advisory.js";

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

interface ToolCallParams {
  name?: string;
  arguments?: Record<string, unknown>;
}

export const MCP_SERVER_INFO = { name: "io.github.DiffCI/diffci", version: "0.2.11" };
const SUPPORTED_PROTOCOLS = new Set(["2025-03-26", "2025-06-18", "2025-11-25"]);
const DEFAULT_PROTOCOL = "2025-11-25";

const validationPlanTool = {
  name: "diffci_validation_plan",
  title: "Create a local DiffCI validation plan",
  description:
    "Plan change-aware CI validation, affected-test selection, test impact analysis, or GitHub Actions workflow checks. Returns a safe local DiffCI command without accessing the checkout or executing it.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["check", "observe", "init", "verify-workflow"],
        description: "Validation action. Defaults to check.",
      },
      repo: {
        type: "string",
        description: "Optional local repository path to pass as a single --repo argument.",
      },
      platform: {
        type: "string",
        enum: ["posix", "powershell"],
        description: "Shell used only to render the display command. Defaults to posix.",
      },
    },
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

const interpretReportTool = {
  name: "diffci_interpret_report",
  title: "Interpret a DiffCI observation report",
  description:
    "Validate and summarize a DiffCI observation report, including selective or full mode, affected-test counts, fallbacks, non-interference evidence, and the conservative next action.",
  inputSchema: {
    type: "object",
    properties: {
      report: { type: "object", description: "A diffci.observation.v1 JSON report." },
    },
    required: ["report"],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

const verifyWorkflowTextTool = {
  name: "diffci_verify_workflow_text",
  title: "Check a GitHub Actions workflow for DiffCI isolation",
  description:
    "Perform a stateless preliminary safety check of GitHub Actions YAML: dedicated observer job, continue-on-error, dependency isolation, read-only permissions, and immutable DiffCI references.",
  inputSchema: {
    type: "object",
    properties: {
      workflow: { type: "string", maxLength: 262144, description: "One GitHub Actions workflow YAML document." },
    },
    required: ["workflow"],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

const tools = [validationPlanTool, interpretReportTool, verifyWorkflowTextTool];

const resources = [
  {
    uri: "diffci://agent-policy",
    name: "DiffCI agent policy",
    description: "Conservative rules for using DiffCI evidence in coding-agent workflows.",
    mimeType: "text/markdown",
  },
  {
    uri: "diffci://mcp-setup",
    name: "DiffCI MCP setup",
    description: "HTTPS and local stdio MCP connection guidance.",
    mimeType: "text/markdown",
  },
];

const prompts = [
  {
    name: "diffci_validate_change",
    title: "Validate a code change with DiffCI",
    description: "Apply DiffCI's conservative validation workflow to the current checkout.",
    arguments: [
      { name: "repository", description: "Repository path, if it is not the current directory.", required: false },
      { name: "run_tests", description: "Set to false to use observe --no-send instead of check.", required: false },
    ],
  },
];

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
    "Access-Control-Expose-Headers": "MCP-Protocol-Version",
    "Cache-Control": "no-store",
  };
}

function json(body: unknown, status = 200, origin: string | null = null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(origin) },
  });
}

function rpcResult(id: JsonRpcId | undefined, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(id: JsonRpcId | undefined, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function validOrigin(request: Request): string | null | false {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password ? parsed.origin : false;
  } catch {
    return false;
  }
}

function quote(value: string, platform: "posix" | "powershell"): string {
  return platform === "powershell"
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", `'"'"'`)}'`;
}

function validationPlan(args: Record<string, unknown>): Record<string, unknown> {
  const requestedAction = typeof args.action === "string" ? args.action : "check";
  const action = ["check", "observe", "init", "verify-workflow"].includes(requestedAction)
    ? requestedAction
    : "check";
  const platform = args.platform === "powershell" ? "powershell" : "posix";
  const repo = typeof args.repo === "string" && args.repo.trim() ? args.repo.trim() : undefined;
  const commandArgs = ["@diffci.com/diffci@latest", action];
  if (action === "observe") commandArgs.push("--no-send");
  if (repo) commandArgs.push("--repo", repo);
  const displayCommand = ["npx", ...commandArgs.map((part) => quote(part, platform))].join(" ");
  const runsTests = action === "check";

  return {
    executable: "npx",
    arguments: commandArgs,
    displayCommand,
    runsTests,
    sendsReports: false,
    nextStep: runsTests
      ? "Read the status, selected or fallback command, pass/fail state, timings, and report path. Keep required CI authoritative."
      : action === "observe"
        ? "Use the observation as change-impact evidence only; no test command is executed."
        : "Inspect the command output and keep existing project configuration authoritative.",
    fallback: "If DiffCI reports REFUSED or ERROR, run the repository's normal validation commands.",
    boundary:
      "The HTTPS MCP endpoint generated this plan but did not access the repository or execute the command. Use the local stdio MCP server for executable repository tools.",
  };
}

function resourceText(uri: string): string | undefined {
  if (uri === "diffci://agent-policy") {
    return `# DiffCI agent policy\n\n- Run \`diffci check\` before PR-ready answers when Git and Node.js 22.5+ are available.\n- Treat selected commands as evidence, never permission to skip required CI.\n- Treat \`REFUSED\` and \`ERROR\` as non-passing results and run the repository's normal validation.\n- Use \`observe --no-send\` when analysis without test execution is required.\n- Nothing is sent without an explicitly configured hosted endpoint and token.\n`;
  }
  if (uri === "diffci://mcp-setup") {
    return `# DiffCI MCP setup\n\nRemote, read-only guidance endpoint: \`https://diffci.com/mcp\`.\n\nFor tools that access the current checkout, run the local stdio server:\n\n\`\`\`bash\nnpx -p "@diffci.com/diffci@latest" diffci-mcp\n\`\`\`\n\nSet the stdio server's working directory to the repository. It exposes \`diffci_check\`, \`diffci_init\`, and \`diffci_verify_workflow\`.\n`;
  }
  return undefined;
}

function handleRpc(request: JsonRpcRequest): Record<string, unknown> | null {
  // This endpoint never initiates requests, but Streamable HTTP permits clients to POST a JSON-RPC
  // response. Accept a structurally valid response as a no-op instead of misclassifying it as a request.
  if (request.jsonrpc === "2.0" && request.id !== undefined && !request.method &&
      (request.result !== undefined || request.error !== undefined)) {
    return null;
  }
  if (request.jsonrpc !== "2.0" || !request.method) {
    return rpcError(request.id, -32600, "Invalid JSON-RPC request");
  }
  switch (request.method) {
    case "initialize": {
      const requested = (request.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      const protocolVersion = typeof requested === "string" && SUPPORTED_PROTOCOLS.has(requested)
        ? requested
        : DEFAULT_PROTOCOL;
      return rpcResult(request.id, {
        protocolVersion,
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: MCP_SERVER_INFO,
        instructions:
          "This public endpoint provides read-only DiffCI validation guidance. Use the local stdio server when tools must inspect or execute against a checkout.",
      });
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping":
      return rpcResult(request.id, {});
    case "tools/list":
      return rpcResult(request.id, { tools });
    case "tools/call": {
      const params = request.params as ToolCallParams | undefined;
      const toolName = params?.name;
      if (!tools.some((tool) => tool.name === toolName)) {
        return rpcError(request.id, -32602, `Unknown tool: ${toolName ?? ""}`);
      }
      const args = params?.arguments ?? {};
      let result: Record<string, unknown>;
      if (toolName === validationPlanTool.name) {
        result = validationPlan(args);
      } else if (toolName === interpretReportTool.name) {
        if (!("report" in args)) return rpcError(request.id, -32602, "report is required");
        result = interpretObservationReport(args.report);
      } else {
        if (typeof args.workflow !== "string") return rpcError(request.id, -32602, "workflow must be a string");
        result = verifyWorkflowText(args.workflow);
      }
      return rpcResult(request.id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
        isError: false,
      });
    }
    case "resources/list":
      return rpcResult(request.id, { resources });
    case "resources/read": {
      const uri = (request.params as { uri?: unknown } | undefined)?.uri;
      const text = typeof uri === "string" ? resourceText(uri) : undefined;
      return text === undefined
        ? rpcError(request.id, -32002, `Resource not found: ${String(uri ?? "")}`)
        : rpcResult(request.id, { contents: [{ uri, mimeType: "text/markdown", text }] });
    }
    case "prompts/list":
      return rpcResult(request.id, { prompts });
    case "prompts/get": {
      const params = request.params as { name?: unknown; arguments?: Record<string, unknown> } | undefined;
      if (params?.name !== prompts[0].name) {
        return rpcError(request.id, -32602, `Unknown prompt: ${String(params?.name ?? "")}`);
      }
      const repository = typeof params.arguments?.repository === "string" ? params.arguments.repository : undefined;
      const runTests = params.arguments?.run_tests !== "false";
      const plan = validationPlan({ action: runTests ? "check" : "observe", repo: repository });
      return rpcResult(request.id, {
        description: prompts[0].description,
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: `Validate the current change with DiffCI. Invoke ${JSON.stringify(plan.executable)} with this exact argument array: ${JSON.stringify(plan.arguments)}. Report the status, selection or fallback reason, commands executed, pass/fail state, timings when measured, and report path. Keep required repository CI authoritative.`,
          },
        }],
      });
    }
    default:
      return rpcError(request.id, -32601, `Method not found: ${request.method}`);
  }
}

export async function handleMcpRequest(request: Request): Promise<Response> {
  const origin = validOrigin(request);
  if (origin === false) {
    return json(rpcError(undefined, -32600, "Forbidden Origin header"), 403);
  }

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders(origin),
        "Access-Control-Allow-Headers": "Content-Type, Accept, MCP-Protocol-Version",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST, OPTIONS", ...corsHeaders(origin) } });
  }

  const contentType = request.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    return json(rpcError(undefined, -32600, "Content-Type must be application/json"), 415, origin);
  }
  const accept = request.headers.get("Accept")?.toLowerCase() ?? "";
  if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
    return json(rpcError(undefined, -32600, "Accept must include application/json and text/event-stream"), 406, origin);
  }
  const protocol = request.headers.get("MCP-Protocol-Version");
  if (protocol && !SUPPORTED_PROTOCOLS.has(protocol)) {
    return json(rpcError(undefined, -32600, `Unsupported MCP-Protocol-Version: ${protocol}`), 400, origin);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(rpcError(undefined, -32700, "Parse error"), 400, origin);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json(rpcError(undefined, -32600, "The request body must be one JSON-RPC message"), 400, origin);
  }

  const message = body as JsonRpcRequest;
  const response = handleRpc(message);
  if (response === null || message.id === undefined) {
    return new Response(null, { status: 202, headers: corsHeaders(origin) });
  }
  return json(response, 200, origin);
}
