import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Type, type TSchema } from "typebox";
import type { ToolArtifactMetadata, ToolArtifactStoreLike } from "../artifacts/tool-artifact-store";
import type { WebFetcher } from "../tools/web-fetch";
import { truncateToolOutput } from "../vault/truncate";
import { McpHttpClient, type McpCallToolResult, type McpToolDefinition } from "./client";
import type { McpAuthType, McpKnownToolSettings, McpServerSettings, McpSettings } from "./settings";

export const MCP_TOOL_PREFIX = "mcp__";

export interface McpToolDetails {
  serverId: string;
  serverName: string;
  remoteToolName: string;
  localToolName: string;
  isError: boolean;
  truncated: boolean;
  artifactId?: string;
  artifactCharLength?: number;
  structuredContentStored?: boolean;
  structuredContentOmitted?: boolean;
  structuredContent?: unknown;
}

export interface McpToolCreationOptions {
  onServerChanged?: () => void | Promise<void>;
  artifactStore?: ToolArtifactStoreLike;
  artifactThresholdChars?: number;
}

export type McpDiagnosticErrorCategory = "auth" | "http" | "network" | "protocol" | "timeout" | "unknown";

export interface McpServerDiagnostic {
  serverId: string;
  serverName: string;
  url: string;
  authType: McpAuthType;
  approval: string;
  checkedAt: string;
  oauth?: {
    hasAccessToken: boolean;
    hasRefreshToken: boolean;
    expiresAt: string | null;
    scope: string;
    authorizationServer: string;
  };
  status: "ok" | "error" | "disabled";
  toolCount: number;
  toolNames: string[];
  errorCategory?: McpDiagnosticErrorCategory;
  error?: string;
}

export interface McpToolCreationResult {
  tools: AgentTool[];
  diagnostics: McpServerDiagnostic[];
}

export interface McpServerProbeResult {
  toolCount: number;
  toolNames: string[];
  tools: McpKnownToolSettings[];
}

const MCP_ARTIFACT_THRESHOLD_CHARS = 8_000;
const MCP_ARTIFACT_PREVIEW_CHARS = 4_000;

export async function createMcpTools(
  settings: McpSettings,
  fetcher: WebFetcher,
  options: McpToolCreationOptions = {},
): Promise<AgentTool[]> {
  return (await createMcpToolsWithDiagnostics(settings, fetcher, options)).tools;
}

export async function createMcpToolsWithDiagnostics(
  settings: McpSettings,
  fetcher: WebFetcher,
  options: McpToolCreationOptions = {},
): Promise<McpToolCreationResult> {
  if (!settings.enabled) return { tools: [], diagnostics: [] };
  const tools: AgentTool[] = [];
  const diagnostics: McpServerDiagnostic[] = [];
  for (const server of settings.servers) {
    if (!server.enabled) {
      diagnostics.push({
        ...baseDiagnostic(server),
        status: "disabled",
        toolCount: 0,
        toolNames: [],
      });
      continue;
    }
    const discovered = await discoverServerTools(server, fetcher, options);
    diagnostics.push(discovered.diagnostic);
    tools.push(...discovered.tools);
  }
  return { tools, diagnostics };
}

export async function probeMcpServer(
  server: McpServerSettings,
  fetcher: WebFetcher,
  options: McpToolCreationOptions = {},
): Promise<McpServerProbeResult> {
  const client = new McpHttpClient({ server, fetcher, onServerChanged: options.onServerChanged });
  const tools = await client.listTools();
  return { toolCount: tools.length, toolNames: tools.map((tool) => tool.name), tools: mcpKnownTools(tools, server.id) };
}

export function isMcpToolName(toolName: string): boolean {
  return toolName.startsWith(MCP_TOOL_PREFIX);
}

export function mcpServerIdFromToolName(toolName: string): string | undefined {
  if (!isMcpToolName(toolName)) return undefined;
  const rest = toolName.slice(MCP_TOOL_PREFIX.length);
  const index = rest.indexOf("__");
  if (index <= 0) return undefined;
  return rest.slice(0, index);
}

export function localMcpToolName(serverId: string, remoteToolName: string): string {
  return `${MCP_TOOL_PREFIX}${sanitizeToolPart(serverId)}__${sanitizeToolPart(remoteToolName)}`;
}

export function localMcpToolNames(serverId: string, remoteToolNames: readonly string[]): string[] {
  const usedNames = new Set<string>();
  return remoteToolNames.map((name) => nextLocalToolName(serverId, name, usedNames));
}

async function discoverServerTools(
  server: McpServerSettings,
  fetcher: WebFetcher,
  options: McpToolCreationOptions,
): Promise<{ tools: AgentTool[]; diagnostic: McpServerDiagnostic }> {
  try {
    const client = new McpHttpClient({ server, fetcher, onServerChanged: options.onServerChanged });
    const remoteTools = await client.listTools();
    const usedNames = new Set<string>();
    const tools = remoteTools.map((tool) =>
      createMcpTool(server, fetcher, options, tool, nextLocalToolName(server.id, tool.name, usedNames)),
    );
    return {
      tools,
      diagnostic: {
        ...baseDiagnostic(server),
        status: "ok",
        toolCount: tools.length,
        toolNames: remoteTools.map((tool) => tool.name),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `Agentic Chat: failed to discover MCP tools for ${server.name}: ${message}`,
    );
    return {
      tools: [],
      diagnostic: {
        ...baseDiagnostic(server),
        status: "error",
        toolCount: 0,
        toolNames: [],
        errorCategory: categorizeMcpDiagnosticError(message),
        error: message,
      },
    };
  }
}

function baseDiagnostic(
  server: McpServerSettings,
): Omit<McpServerDiagnostic, "status" | "toolCount" | "toolNames" | "errorCategory" | "error"> {
  return {
    serverId: server.id,
    serverName: server.name,
    url: server.url,
    authType: server.authType,
    approval: server.approval,
    checkedAt: new Date().toISOString(),
    ...(server.authType === "oauth"
      ? {
          oauth: {
            hasAccessToken: !!server.oauth.accessToken,
            hasRefreshToken: !!server.oauth.refreshToken,
            expiresAt: server.oauth.expiresAt > 0 ? new Date(server.oauth.expiresAt).toISOString() : null,
            scope: server.oauth.scope,
            authorizationServer: server.oauth.authorizationServer,
          },
        }
      : {}),
  };
}

export function categorizeMcpDiagnosticError(message: string): McpDiagnosticErrorCategory {
  const lower = message.toLowerCase();
  if (lower.includes("timed out") || lower.includes("timeout")) return "timeout";
  if (
    lower.includes("oauth") ||
    lower.includes("authentication") ||
    lower.includes("authorization") ||
    lower.includes("insufficient_scope") ||
    lower.includes("http 401") ||
    lower.includes("http 403")
  ) return "auth";
  if (
    lower.includes("network") ||
    lower.includes("proxy") ||
    lower.includes("econn") ||
    lower.includes("eai_") ||
    lower.includes("enotfound") ||
    lower.includes("status 0")
  ) return "network";
  if (
    lower.includes("json-rpc") ||
    lower.includes("json") ||
    lower.includes("protocol") ||
    lower.includes("sse") ||
    lower.includes("stream")
  ) return "protocol";
  if (/http \d{3}/i.test(message)) return "http";
  return "unknown";
}

function createMcpTool(
  server: McpServerSettings,
  fetcher: WebFetcher,
  options: McpToolCreationOptions,
  remoteTool: McpToolDefinition,
  localName: string,
): AgentTool<TSchema, McpToolDetails> {
  const parameters = mcpInputSchema(remoteTool.inputSchema);
  return {
    name: localName,
    label: `${server.name}: ${remoteTool.title || remoteTool.name}`,
    description:
      `${remoteTool.description || `Call ${remoteTool.name} on the ${server.name} MCP server.`}\n\n` +
      `Remote MCP tool "${remoteTool.name}" on ${server.name}. Sends the tool arguments to ${server.url}.`,
    parameters,
    execute: async (_id, params, signal) => {
      const client = new McpHttpClient({ server, fetcher, onServerChanged: options.onServerChanged });
      const result = await client.callTool(remoteTool.name, params as Record<string, unknown>, signal);
      const rendered = await renderMcpResult(result, {
        artifactStore: options.artifactStore,
        artifactThresholdChars: options.artifactThresholdChars,
        localToolName: localName,
        label: `${server.name}: ${remoteTool.title || remoteTool.name}`,
      });
      return {
        content: rendered.content,
        details: {
          serverId: server.id,
          serverName: server.name,
          remoteToolName: remoteTool.name,
          localToolName: localName,
          isError: result.isError === true,
          truncated: rendered.truncated,
          ...(rendered.artifact
            ? {
                artifactId: rendered.artifact.id,
                artifactCharLength: rendered.artifact.charLength,
                structuredContentStored: result.structuredContent !== undefined,
              }
            : rendered.truncated && result.structuredContent !== undefined
              ? { structuredContentOmitted: true }
              : { structuredContent: result.structuredContent }),
        },
      };
    },
  };
}

export function mcpKnownTools(tools: readonly McpToolDefinition[], serverId?: string): McpKnownToolSettings[] {
  const localNames = serverId ? localMcpToolNames(serverId, tools.map((tool) => tool.name)) : [];
  return tools.map((tool) => ({
    name: tool.name,
    ...(serverId ? { localName: localNames.shift() } : {}),
    title: tool.title || tool.name,
    readOnlyHint: tool.annotations?.readOnlyHint === true,
  }));
}

function mcpInputSchema(schema: Record<string, unknown> | undefined): TSchema {
  if (!schema || Object.keys(schema).length === 0) return Type.Object({});
  const normalized = { ...schema };
  if (normalized.type === undefined) normalized.type = "object";
  if (normalized.properties === undefined) normalized.properties = {};
  return normalized as unknown as TSchema;
}

interface RenderMcpResultOptions {
  artifactStore?: ToolArtifactStoreLike;
  artifactThresholdChars?: number;
  localToolName: string;
  label: string;
}

interface RenderMcpResult {
  content: Array<TextContent | ImageContent>;
  truncated: boolean;
  artifact?: ToolArtifactMetadata;
}

async function renderMcpResult(result: McpCallToolResult, options: RenderMcpResultOptions): Promise<RenderMcpResult> {
  const content = Array.isArray(result.content) ? result.content : [];
  const renderedParts = content.map(renderMcpContent).filter((part) => part.trim());
  const structuredContentText = result.structuredContent !== undefined ? safeStringify(result.structuredContent) : "";
  if (structuredContentText && !renderedParts.includes(extractStructuredResultText(result.structuredContent))) {
    renderedParts.push(`Structured content:\n${structuredContentText}`);
  }
  const prefix = result.isError ? "[MCP tool reported an error]\n\n" : "";
  const text = prefix + (renderedParts.length > 0 ? renderedParts.join("\n\n") : "(MCP tool returned no content.)");
  const threshold = options.artifactThresholdChars ?? MCP_ARTIFACT_THRESHOLD_CHARS;
  if (options.artifactStore && text.length > threshold) {
    try {
      const artifact = await options.artifactStore.writeArtifact({
        label: options.label,
        sourceToolName: options.localToolName,
        text,
        contentType: "text/plain",
      });
      return {
        content: [{ type: "text", text: renderArtifactPreview(text, artifact) }],
        truncated: true,
        artifact,
      };
    } catch (error) {
      console.warn(
        `Agentic Chat: failed to store MCP artifact for ${options.localToolName}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  const truncated = text.length > 50_000;
  return { content: [{ type: "text", text: truncateToolOutput(text) }], truncated };
}

function renderArtifactPreview(text: string, artifact: ToolArtifactMetadata): string {
  const preview = text.slice(0, MCP_ARTIFACT_PREVIEW_CHARS);
  return (
    `MCP result stored as artifact "${artifact.id}" because it is ${artifact.charLength.toLocaleString()} characters.\n` +
    'Use read_artifact with this id to inspect it in chunks, or search_artifact to find specific text.\n\n' +
    `Preview (first ${preview.length.toLocaleString()} characters):\n${preview}` +
    (preview.length < text.length ? `\n\n[Preview truncated. Next read offset: ${preview.length}.]` : "")
  );
}

function extractStructuredResultText(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const result = (value as { result?: unknown }).result;
  return typeof result === "string" ? result : "";
}

function renderMcpContent(item: unknown): string {
  const record = item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : {};
  if (record.type === "text" && typeof record.text === "string") return record.text;
  if (record.type === "image") {
    const mime = typeof record.mimeType === "string" ? record.mimeType : "image";
    return `[MCP image content omitted: ${mime}.]`;
  }
  if (record.type === "resource" || record.type === "resource_link") return safeStringify(record);
  return safeStringify(item);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function sanitizeToolPart(input: string): string {
  const sanitized = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return sanitized || "tool";
}

function nextLocalToolName(serverId: string, remoteToolName: string, usedNames: Set<string>): string {
  const base = localMcpToolName(serverId, remoteToolName);
  if (!usedNames.has(base)) {
    usedNames.add(base);
    return base;
  }
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}_${index}`;
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
  }
  const fallback = `${base}_${usedNames.size + 1}`;
  usedNames.add(fallback);
  return fallback;
}
