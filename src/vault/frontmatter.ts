import { parseYaml } from "obsidian";

/** Quote a scalar the way source-artifact frontmatter expects. */
export function formatFrontmatterScalar(value: string): string {
  return JSON.stringify(value.replace(/\r?\n/g, " ").trim());
}

/**
 * Parse the flat `key: value` frontmatter block used by source artifacts.
 * This is deliberately narrower than YAML: it only accepts LF line endings and
 * keeps every value as a string.
 */
export function parseFrontmatterFields(text: string): Map<string, string> | null {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!frontmatter) return null;
  const fields = new Map<string, string>();
  for (const line of frontmatter[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    fields.set(key, parseFrontmatterScalar(rawValue));
  }
  return fields;
}

function parseFrontmatterScalar(value: string): string {
  if (value.startsWith("\"") && value.endsWith("\"")) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed === "string") return parsed;
    } catch {
      return value;
    }
  }
  return value;
}

export type FrontmatterFlavor = "yaml" | "simple";
export type FrontmatterBodyMode = "preserve" | "trimStart" | "drop-one-newline";

export interface SplitFrontmatterOptions {
  /** `yaml` uses Obsidian's parser; `simple` accepts flat keys and [a, b] lists. */
  flavor?: FrontmatterFlavor;
  /** How the body starts after the closing delimiter. */
  body?: FrontmatterBodyMode;
  /** Normalize CRLF/CR to LF before matching (the simple parser does this). */
  normalizeNewlines?: boolean;
  /** Report a YAML parse failure as `parseProblem`; false rethrows it. */
  reportParseProblem?: boolean;
  /** Normalize null and scalar YAML values to {}. False keeps the parsed value. */
  objectOnly?: boolean;
}

export interface SplitFrontmatterResult {
  /** True when the content starts with a `---` frontmatter block. */
  found: boolean;
  data: Record<string, unknown>;
  body: string;
  /** Set when frontmatter exists but failed to parse as YAML. */
  parseProblem?: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

/**
 * Split a frontmatter block from a note. The one frontmatter splitter: skills,
 * the plugin importer, graph tools, and retrieval call it. The options keep
 * the call sites explicit where they differ: delimiter newlines, body
 * whitespace, and how a YAML parse failure or scalar value is handled.
 */
export function splitFrontmatter(
  content: string,
  options: SplitFrontmatterOptions = {},
): SplitFrontmatterResult {
  const normalized = options.normalizeNewlines ? content.replace(/\r\n?/g, "\n") : content;
  const match = FRONTMATTER.exec(normalized);
  if (!match) return { found: false, data: {}, body: normalized };

  const bodyStart = match[0].length;
  const body =
    options.body === "trimStart"
      ? normalized.slice(bodyStart).trimStart()
      : options.body === "drop-one-newline"
        ? normalized.slice(bodyStart).replace(/^\n/, "")
        : normalized.slice(bodyStart);

  if ((options.flavor ?? "yaml") === "simple") {
    return { found: true, data: parseSimpleYaml(match[1]), body };
  }

  try {
    const parsed = parseYaml(match[1]) as unknown;
    if (options.objectOnly === false) {
      return { found: true, data: (parsed ?? {}) as Record<string, unknown>, body };
    }
    return {
      found: true,
      data: parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {},
      body,
    };
  } catch (error) {
    if (options.reportParseProblem === false) throw error;
    const detail = error instanceof Error && error.message ? ` (${error.message})` : "";
    return { found: true, data: {}, body, parseProblem: `frontmatter is not valid YAML${detail}` };
  }
}

function parseSimpleYaml(yaml: string): Record<string, string | readonly string[]> {
  const data: Record<string, string | readonly string[]> = {};
  for (const line of yaml.split("\n")) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    data[match[1]] = parseYamlValue(match[2]);
  }
  return data;
}

function parseYamlValue(value: string): string | readonly string[] {
  const trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((item) => stripQuotes(item.trim()))
      .filter(Boolean);
  }
  return stripQuotes(trimmed);
}

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
