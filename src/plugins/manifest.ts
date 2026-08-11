/**
 * Hand-rolled closed-schema validation for Agent Plugins 1.0.0 manifests.
 *
 * Implements the plugin.json (§5) and mcp.json (§7.2) rules from the
 * agent-plugins.org specification. The canonical JSON Schemas are vendored
 * under `schemas/` for reference and conformance tests; validation here is
 * deliberately dependency-free (no ajv, mobile-safe) and produces precise
 * per-rule reports so the settings UI and `/doctor` can surface failures.
 *
 * Failure semantics (per spec):
 * - plugin.json: unknown top-level fields and non-object `extensions` are
 *   reported + ignored (non-fatal). Any other schema violation is fatal: the
 *   whole plugin is rejected and nothing in it is loaded.
 * - mcp.json: invalid/mismatched top-level disables MCP for that plugin only.
 *   An invalid server entry disables that entry only. Entries whose declared
 *   transport the client does not support are skipped (not errors).
 */
import { assertValidHttpHeaderName, assertValidHttpHeaderValue } from "../mcp/http-headers";

/** Canonical plugin manifest schema identifier for Agent Plugins 1.0.0. */
export const AGENT_PLUGINS_SCHEMA_ID = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
/** Canonical MCP configuration schema identifier for Agent Plugins 1.0.0. */
export const AGENT_PLUGINS_MCP_SCHEMA_ID = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
/** The Agent Plugins spec version this client implements. */
export const AGENT_PLUGINS_VERSION = "1.0.0";

/** Transports this client can actually connect to. Others are skipped + reported. */
export const SUPPORTED_MCP_TRANSPORTS = ["streamable-http"] as const;
export type SupportedMcpTransport = (typeof SUPPORTED_MCP_TRANSPORTS)[number];

export type McpTransport = "stdio" | "streamable-http" | "sse";

/** A single audit line for a manifest/plugin/component. */
export interface PluginReportItem {
  severity: "error" | "warning" | "info";
  message: string;
}

export interface PluginManifestAuthor {
  name?: string;
  email?: string;
  url?: string;
}

/** The portable fields of a valid plugin.json. */
export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  author?: PluginManifestAuthor;
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  /** Client extension namespaces; contents are ignored unless implemented. */
  extensions?: Record<string, unknown>;
}

export interface PluginManifestValidation {
  /** Parsed manifest when the required fields are valid; null on fatal violations. */
  manifest: PluginManifest | null;
  /** Fatal violation that rejects the whole plugin, or null. */
  fatal: string | null;
  reports: PluginReportItem[];
}

export interface PluginMcpServer {
  /** Server key as written in mcpServers. */
  key: string;
  transport: McpTransport;
  /** Remote transports only. */
  url?: string;
  /** Remote transports only: literal request headers (never credentials). */
  headers?: Record<string, string>;
  /** stdio only. */
  command?: string;
  /** stdio only. */
  args?: string[];
  /** stdio only. */
  env?: Record<string, string>;
  /** stdio only. */
  cwd?: string;
  /** Validation problems that make this entry invalid (entry is skipped). */
  problems: string[];
}

export interface PluginMcpValidation {
  /** True when mcp.json is valid at the top level (schema + version match). */
  ok: boolean;
  /** Fatal top-level reason; null when ok. */
  reason: string | null;
  /** Parsed server entries (valid or invalid; unsupported transports included for reporting). */
  servers: PluginMcpServer[];
  reports: PluginReportItem[];
}

const PLUGIN_TOP_LEVEL_FIELDS = new Set([
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
]);

/**
 * Parse + validate a plugin.json document. Returns either the parsed manifest
 * (fatal === null) or the fatal violation plus any non-fatal reports.
 */
export function validatePluginManifest(raw: string): PluginManifestValidation {
  const reports: PluginReportItem[] = [];
  const value = parseJsonObject(raw);
  if (value === undefined) {
    return { manifest: null, fatal: "plugin.json is not valid JSON.", reports };
  }

  for (const key of Object.keys(value)) {
    if (!PLUGIN_TOP_LEVEL_FIELDS.has(key)) {
      reports.push({ severity: "warning", message: `Unknown top-level field "${key}" ignored.` });
    }
  }

  const schema = value["$schema"];
  if (schema !== AGENT_PLUGINS_SCHEMA_ID) {
    if (typeof schema !== "string") {
      return {
        manifest: null,
        fatal: 'plugin.json must declare a "$schema" string.',
        reports,
      };
    }
    return {
      manifest: null,
      fatal:
        `plugin.json targets unsupported Agent Plugins schema "${schema}". ` +
        `This client supports ${AGENT_PLUGINS_VERSION} (${AGENT_PLUGINS_SCHEMA_ID}).`,
      reports,
    };
  }

  const nameValue = value.name;
  if (typeof nameValue !== "string" || !validatePluginName(nameValue)) {
    return {
      manifest: null,
      fatal:
        'plugin.json "name" must be 1-64 characters of a-z, 0-9, "-" and ".", ' +
        "start and end alphanumeric, with no \"--\" or \"..\".",
      reports,
    };
  }

  const fatalField = firstFatalFieldViolation(value, reports);
  if (fatalField) return { manifest: null, fatal: fatalField, reports };

  return {
    manifest: {
      name: nameValue,
      ...(typeof value.version === "string" ? { version: value.version } : {}),
      ...(typeof value.description === "string" ? { description: value.description } : {}),
      ...(isAuthorObject(value.author) ? { author: value.author as PluginManifestAuthor } : {}),
      ...(typeof value.homepage === "string" ? { homepage: value.homepage } : {}),
      ...(typeof value.repository === "string" ? { repository: value.repository } : {}),
      ...(typeof value.license === "string" ? { license: value.license } : {}),
      ...(isStringArray(value.keywords) ? { keywords: value.keywords as string[] } : {}),
      ...(isRecord(value.extensions) ? { extensions: value.extensions as Record<string, unknown> } : {}),
    },
    fatal: null,
    reports,
  };
}

/** Returns the fatal violation message for a known top-level field, or null. */
function firstFatalFieldViolation(value: Record<string, unknown>, reports: PluginReportItem[]): string | null {
  const check = (field: string, valid: boolean, message: string): string | null => {
    if (valid) return null;
    reports.push({ severity: "error", message });
    return message;
  };

  if (value.version !== undefined && typeof value.version !== "string") {
    return check("version", false, 'plugin.json "version" must be a string.');
  }
  if (value.description !== undefined && typeof value.description !== "string") {
    return check("description", false, 'plugin.json "description" must be a string.');
  }
  if (value.homepage !== undefined && typeof value.homepage !== "string") {
    return check("homepage", false, 'plugin.json "homepage" must be a string.');
  }
  if (value.repository !== undefined && typeof value.repository !== "string") {
    return check("repository", false, 'plugin.json "repository" must be a string.');
  }
  if (value.license !== undefined && typeof value.license !== "string") {
    return check("license", false, 'plugin.json "license" must be a string.');
  }
  if (value.keywords !== undefined && !isStringArray(value.keywords)) {
    return check("keywords", false, 'plugin.json "keywords" must be an array of strings.');
  }
  if (value.author !== undefined && !isAuthorObject(value.author)) {
    return check("author", false, 'plugin.json "author" must be an object with only name, email, and url strings.');
  }
  if (value.extensions !== undefined && !isRecord(value.extensions)) {
    // Non-object extensions is explicitly non-fatal: report + ignore.
    reports.push({
      severity: "warning",
      message: 'plugin.json "extensions" is not an object; it was ignored.',
    });
  }
  return null;
}

/**
 * Validate an mcp.json document for a plugin that already passed manifest
 * validation (version match against the plugin's declared schema is checked
 * by the caller via `validateMcpVersion`).
 */
export function validateMcpConfig(raw: string, expectedSchemaId: string): PluginMcpValidation {
  const reports: PluginReportItem[] = [];
  const value = parseJsonObject(raw);
  if (value === undefined) {
    return {
      ok: false,
      reason: "mcp.json is not valid JSON.",
      servers: [],
      reports,
    };
  }

  const topLevelKeys = Object.keys(value);
  if (topLevelKeys.length === 0 || topLevelKeys.some((key) => key !== "$schema" && key !== "mcpServers")) {
    return {
      ok: false,
      reason: 'mcp.json must be an object containing only "$schema" and "mcpServers".',
      servers: [],
      reports,
    };
  }

  const schema = value["$schema"];
  if (schema !== expectedSchemaId) {
    return {
      ok: false,
      reason:
        `mcp.json "$schema" (${String(schema)}) does not match the plugin manifest version ` +
        `(${expectedSchemaId}).`,
      servers: [],
      reports,
    };
  }
  if (schema !== AGENT_PLUGINS_MCP_SCHEMA_ID) {
    return {
      ok: false,
      reason: `mcp.json targets unsupported Agent Plugins schema "${String(schema)}".`,
      servers: [],
      reports,
    };
  }

  const mcpServers = value.mcpServers;
  if (!isRecord(mcpServers)) {
    return {
      ok: false,
      reason: 'mcp.json "mcpServers" must be an object.',
      servers: [],
      reports,
    };
  }

  const servers: PluginMcpServer[] = [];
  for (const [key, entry] of Object.entries(mcpServers as Record<string, unknown>)) {
    servers.push(validateMcpServerEntry(key, entry, reports));
  }
  return { ok: true, reason: null, servers, reports };
}

function validateMcpServerEntry(key: string, value: unknown, reports: PluginReportItem[]): PluginMcpServer {
  const problems: string[] = [];
  const record = isRecord(value) ? (value as Record<string, unknown>) : null;
  if (!record) {
    problems.push("server entry must be an object.");
    reports.push({ severity: "error", message: `mcp.json server "${key}" is not an object; skipped.` });
    return { key, transport: "streamable-http", problems };
  }

  const transport = record.type;
  if (transport !== "stdio" && transport !== "streamable-http" && transport !== "sse") {
    problems.push(`unknown transport type "${String(transport)}".`);
    reports.push({ severity: "error", message: `mcp.json server "${key}" has ${problems[0]}` });
    return { key, transport: "streamable-http", problems };
  }

  const allowedFields =
    transport === "stdio"
      ? new Set(["type", "command", "args", "env", "cwd"])
      : new Set(["type", "url", "headers"]);
  for (const field of Object.keys(record)) {
    if (!allowedFields.has(field)) {
      problems.push(`unknown or misplaced field "${field}" for ${transport}.`);
    }
  }

  if (transport === "stdio") {
    validateStdioEntry(key, record, problems, reports);
  } else {
    validateRemoteEntry(key, record as Record<string, unknown>, problems, reports);
  }

  if (problems.length > 0) {
    reports.push({ severity: "error", message: `mcp.json server "${key}" is invalid; skipped.` });
  }
  return {
    key,
    transport,
    ...(typeof record.url === "string" ? { url: record.url } : {}),
    ...(isStringRecord(record.headers) ? { headers: record.headers as Record<string, string> } : {}),
    ...(typeof record.command === "string" ? { command: record.command } : {}),
    ...(Array.isArray(record.args) && record.args.every((arg) => typeof arg === "string")
      ? { args: record.args as string[] }
      : {}),
    ...(isStringRecord(record.env) ? { env: record.env as Record<string, string> } : {}),
    ...(typeof record.cwd === "string" ? { cwd: record.cwd } : {}),
    problems,
  };
}

function validateStdioEntry(
  key: string,
  record: Record<string, unknown>,
  problems: string[],
  reports: PluginReportItem[],
): void {
  const command = record.command;
  if (typeof command !== "string" || !command.trim()) {
    problems.push("stdio servers require a non-empty \"command\" string.");
  } else if (!isSingleExecutableToken(command)) {
    problems.push('stdio "command" must be a single executable token (bare name or "./"-relative path).');
  }
  if (record.args !== undefined && !(Array.isArray(record.args) && record.args.every((arg) => typeof arg === "string"))) {
    problems.push('stdio "args" must be an array of strings.');
  }
  if (record.env !== undefined) {
    if (!isStringRecord(record.env)) {
      problems.push('stdio "env" must be an object of strings.');
    } else {
      const env = record.env as Record<string, string>;
      for (const envKey of Object.keys(env)) {
        if (envKey === "PLUGIN_ROOT" || envKey === "PLUGIN_DATA") {
          problems.push(`stdio "env" must not override the reserved variable ${envKey}.`);
        }
      }
    }
  }
  if (record.cwd !== undefined) {
    const cwd = record.cwd;
    if (typeof cwd !== "string" || !validCwdForm(cwd)) {
      problems.push(
        'stdio "cwd" must be "./"-relative, ${PLUGIN_ROOT}-rooted, or ${PLUGIN_DATA}-rooted, within the boundary.',
      );
    }
  }
  if (!(SUPPORTED_MCP_TRANSPORTS as readonly string[]).includes("stdio")) {
    reports.push({
      severity: "info",
      message: `mcp.json server "${key}" uses stdio, which this client does not support; skipped.`,
    });
  }
}

function validateRemoteEntry(
  key: string,
  record: Record<string, unknown>,
  problems: string[],
  reports: PluginReportItem[],
): void {
  const url = record.url;
  if (typeof url !== "string" || !url.trim()) {
    problems.push('remote servers require a non-empty "url" string.');
  } else {
    const urlProblem = validateMcpUrl(url);
    if (urlProblem) problems.push(urlProblem);
  }
  if (record.headers !== undefined) {
    if (!isStringRecord(record.headers)) {
      problems.push('"headers" must be an object of strings.');
    } else {
      validateMcpHeaders(record.headers as Record<string, string>, problems);
    }
  }
  const transport = record.type as McpTransport;
  if (!(SUPPORTED_MCP_TRANSPORTS as readonly string[]).includes(transport)) {
    reports.push({
      severity: "info",
      message: `mcp.json server "${key}" uses ${transport}, which this client does not support; skipped.`,
    });
  }
}

/** Absolute HTTP(S) URL, no user info or fragment; non-loopback hosts require HTTPS. */
export function validateMcpUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '"url" must be a valid absolute URL.';
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return '"url" must use http:// or https://.';
  }
  if (parsed.username || parsed.password) return '"url" must not contain user information.';
  if (parsed.hash) return '"url" must not contain a fragment.';
  if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
    return "non-loopback " + '"url" values must use https://.';
  }
  return null;
}

function validateMcpHeaders(headers: Record<string, string>, problems: string[]): void {
  const seenLower = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    try {
      assertValidHttpHeaderName(name);
      assertValidHttpHeaderValue(value);
    } catch (error) {
      problems.push(`invalid header "${name}": ${error instanceof Error ? error.message : String(error)}`);
    }
    const lower = name.toLowerCase();
    if (seenLower.has(lower)) {
      problems.push(`header "${name}" is repeated under different casing.`);
    }
    seenLower.add(lower);
  }
}

/** stdio `command` is one executable token: a bare name or a "./"-relative path. */
export function isSingleExecutableToken(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("./")) return true;
  return !/[\s/]/.test(trimmed);
}

/** cwd forms: "./", ${PLUGIN_ROOT}-rooted, or ${PLUGIN_DATA}-rooted, inside the boundary. */
export function validCwdForm(cwd: string): boolean {
  if (cwd.startsWith("./")) return true;
  if (cwd === "${PLUGIN_ROOT}" || cwd.startsWith("${PLUGIN_ROOT}/")) return true;
  if (cwd === "${PLUGIN_DATA}" || cwd.startsWith("${PLUGIN_DATA}/")) return true;
  return false;
}

/** Loopback hosts: "localhost" or an IP literal in a loopback range (127/8, ::1). */
export function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === "localhost") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(lower)) {
    const first = Number.parseInt(lower.split(".")[0] ?? "0", 10);
    return first === 127;
  }
  return lower === "::1" || lower === "[::1]";
}

/**
 * Plugin names: 1-64 chars of [a-z0-9-.] starting/ending alphanumeric,
 * no consecutive hyphens or periods.
 */
export function validatePluginName(name: string): boolean {
  if (name.length < 1 || name.length > 64) return false;
  if (!/^[a-z0-9.-]+$/.test(name)) return false;
  if (!/^[a-z0-9]/.test(name) || !/[a-z0-9]$/.test(name)) return false;
  if (name.includes("--") || name.includes("..")) return false;
  return true;
}

/** Slugify a user-supplied server/plugin name into a valid plugin name. */
export function slugifyPluginName(input: string): string {
  const slugged = input
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/--+/g, "-")
    .replace(/\.\.+/g, ".")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .slice(0, 64);
  if (validatePluginName(slugged)) return slugged;
  return "plugin";
}

function isRecord(value: unknown): boolean {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringRecord(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.values(value as Record<string, unknown>).every((item) => typeof item === "string");
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isAuthorObject(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const allowed = new Set(["name", "email", "url"]);
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!allowed.has(key) || typeof item !== "string") return false;
  }
  return true;
}

/** Parse text as a JSON object; returns undefined for anything else. */
export function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return isRecord(parsed) ? (parsed as Record<string, unknown>) : undefined;
}
