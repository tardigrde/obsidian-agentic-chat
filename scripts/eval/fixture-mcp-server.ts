import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import process from "node:process";
import {
  JSON_CONTENT_TYPE,
  TEXT_CONTENT_TYPE,
  requestUrl,
  runFixtureCli,
  send,
  startLocalHttpServer,
  type LocalHttpServer,
} from "./fixture-http";

/**
 * A fake Streamable HTTP MCP server for local evals. It answers JSON-RPC over
 * POST with JSON bodies, issues `Mcp-Session-Id` on initialize, and never
 * contacts the network. Request bodies and headers are not logged.
 */

export interface FixtureMcpServerOptions {
  /** Port to bind on the dual-stack wildcard listener. Default 0: the OS assigns a free port. The fixture serves static test data and closes after the run. */
  port?: number;
  /** Number of tools in tools/list. Default 30. */
  toolCount?: number;
}

/** The MCP endpoint, for example http://localhost:41234/mcp. */
export type FixtureMcpServer = LocalHttpServer;

const ENDPOINT = "/mcp";
const DEFAULT_TOOL_COUNT = 30;
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2024-11-05"] as const;
const PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
const SERVER_NAME = "agentic-chat-fixture-mcp";
const SERVER_VERSION = "0.0.0";

interface SchemaProperty {
  type: "string" | "integer" | "boolean";
  description: string;
}

interface ToolSpec {
  name: string;
  description: string;
  readOnly: boolean;
  properties: Record<string, SchemaProperty>;
  required?: string[];
}

interface FixtureTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint: boolean };
}

const query: SchemaProperty = { type: "string", description: "Free-text query." };
const limit: SchemaProperty = { type: "integer", description: "Maximum number of items to return." };
const status: SchemaProperty = { type: "string", description: "Status filter or target status." };
const documentId: SchemaProperty = { type: "string", description: "Document id, for example DOC-12." };
const ticketId: SchemaProperty = { type: "string", description: "Ticket id, for example T-42." };
const eventId: SchemaProperty = { type: "string", description: "Calendar event id, for example EV-7." };
const filePath: SchemaProperty = { type: "string", description: "Workspace-relative file path." };
const userId: SchemaProperty = { type: "string", description: "User id, for example U-1." };
const title: SchemaProperty = { type: "string", description: "Human-readable title." };
const body: SchemaProperty = { type: "string", description: "Text body." };

/**
 * Thirty tools across six areas, so a future `search_tools` case must pick one
 * out of a realistic list instead of an obvious single match.
 */
const TOOL_SPECS: ToolSpec[] = [
  // Search
  {
    name: "search_documents",
    description: "Search workspace documents by title or body text.",
    readOnly: true,
    properties: { query, limit },
    required: ["query"],
  },
  {
    name: "search_web",
    description: "Search the web and return result snippets.",
    readOnly: true,
    properties: { query, limit },
    required: ["query"],
  },
  {
    name: "search_tickets",
    description: "Search support tickets by keyword or status.",
    readOnly: true,
    properties: { query, status, limit },
    required: ["query"],
  },
  {
    name: "search_people",
    description: "Search the workspace directory for people.",
    readOnly: true,
    properties: { query, limit },
    required: ["query"],
  },
  {
    name: "search_code",
    description: "Search indexed repositories for a code pattern.",
    readOnly: true,
    properties: {
      query,
      repository: { type: "string", description: "Repository name to search." },
    },
    required: ["query"],
  },
  // Documents
  {
    name: "get_document",
    description: "Fetch one document by id.",
    readOnly: true,
    properties: { documentId },
    required: ["documentId"],
  },
  {
    name: "list_documents",
    description: "List documents in a workspace folder.",
    readOnly: true,
    properties: {
      folder: { type: "string", description: "Folder path, for example docs/." },
      limit,
    },
  },
  {
    name: "create_document",
    description: "Create a document from markdown.",
    readOnly: false,
    properties: { title, body, folder: { type: "string", description: "Target folder path." } },
    required: ["title", "body"],
  },
  {
    name: "update_document",
    description: "Replace the body of an existing document.",
    readOnly: false,
    properties: { documentId, body },
    required: ["documentId", "body"],
  },
  {
    name: "export_document",
    description: "Export a document as markdown or PDF.",
    readOnly: true,
    properties: {
      documentId,
      format: { type: "string", description: "Export format: markdown or pdf." },
    },
    required: ["documentId", "format"],
  },
  // Tickets
  {
    name: "list_tickets",
    description: "List tickets by status and assignee.",
    readOnly: true,
    properties: {
      status,
      assignee: { type: "string", description: "Assignee name or user id." },
      limit,
    },
  },
  {
    name: "get_ticket",
    description: "Fetch one ticket with its comments.",
    readOnly: true,
    properties: { ticketId },
    required: ["ticketId"],
  },
  {
    name: "create_ticket",
    description: "Open a new support ticket.",
    readOnly: false,
    properties: {
      title,
      description: { type: "string", description: "What went wrong." },
      priority: { type: "string", description: "low, normal, or high." },
    },
    required: ["title", "description"],
  },
  {
    name: "update_ticket_status",
    description: "Move a ticket to a new status.",
    readOnly: false,
    properties: { ticketId, status },
    required: ["ticketId", "status"],
  },
  {
    name: "add_ticket_comment",
    description: "Add a comment to a ticket.",
    readOnly: false,
    properties: { ticketId, comment: { type: "string", description: "Comment text." } },
    required: ["ticketId", "comment"],
  },
  // Calendar
  {
    name: "list_calendar_events",
    description: "List calendar events in a date range.",
    readOnly: true,
    properties: {
      from: { type: "string", description: "Start date, ISO 8601." },
      to: { type: "string", description: "End date, ISO 8601." },
    },
  },
  {
    name: "get_calendar_event",
    description: "Fetch one calendar event.",
    readOnly: true,
    properties: { eventId },
    required: ["eventId"],
  },
  {
    name: "create_calendar_event",
    description: "Create a calendar event.",
    readOnly: false,
    properties: {
      title,
      start: { type: "string", description: "Start time, ISO 8601." },
      end: { type: "string", description: "End time, ISO 8601." },
      attendees: { type: "string", description: "Comma-separated attendee emails." },
    },
    required: ["title", "start", "end"],
  },
  {
    name: "update_calendar_event",
    description: "Change the time or title of a calendar event.",
    readOnly: false,
    properties: {
      eventId,
      title,
      start: { type: "string", description: "New start time, ISO 8601." },
    },
    required: ["eventId"],
  },
  {
    name: "find_free_slots",
    description: "Find open meeting slots for a set of attendees.",
    readOnly: true,
    properties: {
      attendees: { type: "string", description: "Comma-separated attendee emails." },
      durationMinutes: { type: "integer", description: "Meeting length in minutes." },
    },
    required: ["attendees", "durationMinutes"],
  },
  // Files
  {
    name: "list_files",
    description: "List files in a workspace folder.",
    readOnly: true,
    properties: {
      folder: { type: "string", description: "Folder path, for example notes/." },
      limit,
    },
  },
  {
    name: "read_file",
    description: "Read a text file from the workspace.",
    readOnly: true,
    properties: { filePath },
    required: ["filePath"],
  },
  {
    name: "write_file",
    description: "Write text to a workspace file.",
    readOnly: false,
    properties: { filePath, content: { type: "string", description: "File content." } },
    required: ["filePath", "content"],
  },
  {
    name: "move_file",
    description: "Move or rename a workspace file.",
    readOnly: false,
    properties: {
      filePath,
      destination: { type: "string", description: "New workspace-relative path." },
    },
    required: ["filePath", "destination"],
  },
  {
    name: "delete_file",
    description: "Delete a workspace file.",
    readOnly: false,
    properties: { filePath },
    required: ["filePath"],
  },
  // Admin
  {
    name: "list_users",
    description: "List workspace users and their roles.",
    readOnly: true,
    properties: { role: { type: "string", description: "Filter by role: admin or member." } },
  },
  {
    name: "get_user",
    description: "Fetch one user profile.",
    readOnly: true,
    properties: { userId },
    required: ["userId"],
  },
  {
    name: "invite_user",
    description: "Invite a person to the workspace.",
    readOnly: false,
    properties: {
      email: { type: "string", description: "Invitee email address." },
      role: { type: "string", description: "Role to grant: admin or member." },
    },
    required: ["email", "role"],
  },
  {
    name: "list_audit_log",
    description: "List recent admin audit events.",
    readOnly: true,
    properties: {
      action: { type: "string", description: "Filter by action name." },
      limit,
    },
  },
  {
    name: "get_workspace_settings",
    description: "Read workspace-wide settings.",
    readOnly: true,
    properties: {},
  },
];

function objectSchema(
  properties: Record<string, SchemaProperty>,
  required: readonly string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

function buildTools(toolCount: number): FixtureTool[] {
  const count = Number.isFinite(toolCount) ? Math.max(0, Math.trunc(toolCount)) : 0;
  return Array.from({ length: count }, (_, index) => {
    const spec = TOOL_SPECS[index];
    if (!spec) {
      return {
        name: `admin_extra_${index + 1}`,
        description: `Admin fixture tool ${index + 1} for tool-search cases.`,
        inputSchema: objectSchema({ note: { type: "string", description: "Optional note." } }),
        annotations: { readOnlyHint: true },
      };
    }
    return {
      name: spec.name,
      description: spec.description,
      inputSchema: objectSchema(spec.properties, spec.required),
      ...(spec.readOnly ? { annotations: { readOnlyHint: true } } : {}),
    };
  });
}

function sendJsonRpcResult(
  response: ServerResponse,
  id: number | string,
  result: unknown,
  headers: Record<string, string> = {},
): void {
  send(response, 200, JSON_CONTENT_TYPE, JSON.stringify({ jsonrpc: "2.0", id, result }), {
    "cache-control": "no-store",
    ...headers,
  });
}

function sendJsonRpcError(response: ServerResponse, id: number | string | null, code: number, message: string): void {
  send(response, 200, JSON_CONTENT_TYPE, JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    "cache-control": "no-store",
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringArg(args: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) {
    const value = args[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortValue(item)]),
    );
  }
  return value;
}

/** A few tools return fixed records; the rest echo their arguments, so every call is deterministic. */
function toolResult(name: string, args: Record<string, unknown>): { content: Array<{ type: "text"; text: string }> } {
  let text: string;
  switch (name) {
    case "search_documents": {
      const queryText = stringArg(args, "query") || "all documents";
      text = `Found 2 documents for "${queryText}":\n- DOC-12 Onboarding guide\n- DOC-31 Release checklist`;
      break;
    }
    case "get_document": {
      const id = stringArg(args, "documentId") || "DOC-12";
      text = `# Release checklist (${id})\n\n1. Run the unit suite.\n2. Run the fast lane.\n3. Tag the release.`;
      break;
    }
    case "get_ticket": {
      const id = stringArg(args, "ticketId") || "T-1";
      text = `Ticket ${id}\nStatus: open\nPriority: normal\nSummary: Printer is offline on floor 3.`;
      break;
    }
    case "list_calendar_events":
      text =
        "2026-12-01 09:00-09:30 UTC Standup\n2026-12-01 14:00-15:00 UTC Design review";
      break;
    case "read_file": {
      const path = stringArg(args, "filePath") || "notes/today.md";
      text = `# ${path}\n\nFixture file content is deterministic.`;
      break;
    }
    case "list_users":
      text = "U-1 Avery Chen (admin)\nU-2 Blake Silva (member)";
      break;
    default:
      text = `${name} completed with arguments ${JSON.stringify(sortValue(args))}.`;
  }
  return { content: [{ type: "text", text }] };
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

async function readJsonRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<Record<string, unknown> | undefined> {
  let payload: unknown;
  try {
    payload = JSON.parse(await readBody(request));
  } catch {
    send(response, 400, TEXT_CONTENT_TYPE, "Bad Request: body must be JSON.\n");
    return undefined;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    sendJsonRpcError(response, null, -32600, "Invalid Request.");
    return undefined;
  }
  return payload as Record<string, unknown>;
}

function replyInitialize(response: ServerResponse, id: number | string, params: Record<string, unknown>): void {
  const requested = typeof params.protocolVersion === "string" ? params.protocolVersion.trim() : "";
  const protocolVersion =
    SUPPORTED_PROTOCOL_VERSIONS.find((version) => version === requested) ?? PROTOCOL_VERSION;
  sendJsonRpcResult(
    response,
    id,
    {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    },
    { "mcp-session-id": randomUUID() },
  );
}

function replyToolCall(
  response: ServerResponse,
  id: number | string,
  tools: readonly FixtureTool[],
  params: Record<string, unknown>,
): void {
  const name = typeof params.name === "string" ? params.name : "";
  if (!name) {
    sendJsonRpcError(response, id, -32602, "Invalid params: tool name is required.");
    return;
  }
  if (!tools.some((tool) => tool.name === name)) {
    sendJsonRpcError(response, id, -32602, `Unknown tool: ${name}`);
    return;
  }
  sendJsonRpcResult(response, id, toolResult(name, asRecord(params.arguments)));
}

async function handlePost(request: IncomingMessage, response: ServerResponse, tools: readonly FixtureTool[]): Promise<void> {
  const message = await readJsonRequest(request, response);
  if (!message) return;
  const method = typeof message.method === "string" ? message.method : "";
  const hasId = typeof message.id === "number" || typeof message.id === "string";
  if (!method) {
    sendJsonRpcError(response, hasId ? (message.id as number | string) : null, -32600, "Invalid Request: method is required.");
    return;
  }
  if (!hasId) {
    // Notifications (including notifications/initialized) have no reply body.
    response.writeHead(202);
    response.end();
    return;
  }
  const id = message.id as number | string;
  const params = asRecord(message.params);
  switch (method) {
    case "initialize":
      replyInitialize(response, id, params);
      return;
    case "ping":
      sendJsonRpcResult(response, id, {});
      return;
    case "tools/list":
      sendJsonRpcResult(response, id, { tools });
      return;
    case "tools/call":
      replyToolCall(response, id, tools, params);
      return;
    default:
      sendJsonRpcError(response, id, -32601, `Method not found: ${method}`);
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  tools: readonly FixtureTool[],
): Promise<void> {
  const url = requestUrl(request, response);
  if (!url) return;
  if (url.pathname !== ENDPOINT) {
    send(response, 404, TEXT_CONTENT_TYPE, "Not Found\n");
    return;
  }
  if (request.method !== "POST") {
    // The fixture answers JSON on POST. It never returns 202, so the product
    // client never needs the standalone GET/SSE stream.
    send(response, 405, TEXT_CONTENT_TYPE, "Method Not Allowed\n", { allow: "POST" });
    return;
  }
  await handlePost(request, response, tools);
}

export function startFixtureMcpServer(options: FixtureMcpServerOptions = {}): Promise<FixtureMcpServer> {
  const tools = buildTools(options.toolCount ?? DEFAULT_TOOL_COUNT);
  return startLocalHttpServer((request, response) => handleRequest(request, response, tools), {
    port: options.port,
    path: ENDPOINT,
  });
}

runFixtureCli(import.meta.url, process.argv.slice(2), "--tools", (args) =>
  startFixtureMcpServer({ port: args.port, toolCount: args.extra }),
);
