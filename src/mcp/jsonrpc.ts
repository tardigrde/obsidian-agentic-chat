import type { WebHttpResponse } from "../tools/web-fetch";
import { asRecord } from "../utils/records";

/** Pure JSON-RPC 2.0 and SSE framing. No transport, retry, auth, or server state. */

export interface McpToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface JsonRpcSuccess<T> {
  jsonrpc: "2.0";
  id: number | string | null;
  result: T;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: number | string | null;
  error: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

export type JsonRpcResponse<T> = JsonRpcSuccess<T> | JsonRpcFailure;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

/** An SSE body ended without the JSON-RPC result the caller is waiting for. */
export class McpSseResponseIncompleteError extends Error {
  constructor(readonly lastEventId: string | undefined) {
    super("MCP SSE response ended without a matching JSON-RPC result.");
  }
}

export function parseJsonRpcResponse<T>(response: WebHttpResponse, id: number): JsonRpcResponse<T> {
  const parsed = parseJsonBodyOrSse(response.text, response.headers["content-type"] ?? "", id);
  const record = asRecord(parsed);
  if (record.error && typeof record.error === "object") return record as unknown as JsonRpcFailure;
  if ("result" in record) return record as unknown as JsonRpcSuccess<T>;
  throw new Error("MCP server returned an invalid JSON-RPC response.");
}

function parseJsonBodyOrSse(text: string, contentType: string, id: number): unknown {
  if (!/text\/event-stream/i.test(contentType) && !text.trimStart().startsWith("data:")) {
    return JSON.parse(text || "{}");
  }
  let lastEventId: string | undefined;
  for (const event of text.split(/\r?\n\r?\n+/)) {
    const lines = event.split(/\r?\n/);
    const eventId = lines.find((line) => line.startsWith("id:"))?.slice(3).trimStart();
    if (eventId) lastEventId = eventId;
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data) continue;
    const parsed: unknown = JSON.parse(data);
    const record = asRecord(parsed);
    if (record.id === id || record.id === String(id)) return parsed;
  }
  throw new McpSseResponseIncompleteError(lastEventId);
}

export function parseTools(value: unknown): McpToolDefinition[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    const name = asString(record.name).trim();
    if (!name) return [];
    return [
      {
        name,
        title: asString(record.title),
        description: asString(record.description),
        inputSchema: asSchema(record.inputSchema),
        outputSchema: asSchema(record.outputSchema),
        annotations: asRecord(record.annotations),
      },
    ];
  });
}

function asSchema(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  return Object.keys(record).length > 0 ? record : undefined;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
