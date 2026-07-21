import type { App, TFile } from "obsidian";
import type { IgnoreMatcher } from "../vault/ignore";
import type { RetrievalDocument } from "./policy";
import { isPathInProjectScope } from "../projects/projects";

export async function loadVaultRetrievalDocuments(
  app: App,
  ignoreMatcher?: IgnoreMatcher,
  scopeFolders?: readonly string[],
): Promise<RetrievalDocument[]> {
  const files = (app.vault as App["vault"] & { getMarkdownFiles: () => TFile[]; cachedRead: (file: TFile) => Promise<string> })
    .getMarkdownFiles()
    .filter((file) => !ignoreMatcher?.(file.path) && isPathInProjectScope(file.path, scopeFolders ?? []));
  const documents = await Promise.all(
    files.map(async (file) =>
      markdownToRetrievalDocument({
        id: file.path,
        path: file.path,
        basename: file.basename,
        modifiedTime: (file as { stat?: { mtime?: number } }).stat?.mtime,
        content: await app.vault.cachedRead(file),
      }),
    ),
  );
  return withBacklinks(documents);
}

export function markdownToRetrievalDocument(input: {
  id: string;
  path: string;
  basename: string;
  content: string;
  modifiedTime?: number;
}): RetrievalDocument {
  const { frontmatter, body } = splitFrontmatter(input.content);
  const aliases = stringList(frontmatter.aliases ?? frontmatter.alias);
  const frontmatterTags = stringList(frontmatter.tags ?? frontmatter.tag);
  const contentTags = extractTags(body);
  return {
    id: input.id,
    path: input.path,
    title: firstHeading(body) ?? input.basename,
    content: body,
    language: typeof frontmatter.lang === "string" ? frontmatter.lang : undefined,
    tags: [...new Set([...frontmatterTags, ...contentTags])],
    aliases,
    frontmatter,
    links: extractWikiLinks(body),
    backlinks: [],
    modifiedTime: input.modifiedTime,
  };
}

function withBacklinks(documents: readonly RetrievalDocument[]): RetrievalDocument[] {
  const byPath = new Map(documents.map((document) => [normalizePath(document.path), document]));
  const backlinks = new Map<string, string[]>();
  for (const document of documents) {
    for (const link of document.links ?? []) {
      const target = resolveLinkedPath(link, byPath);
      if (!target) continue;
      const list = backlinks.get(target) ?? [];
      list.push(document.path);
      backlinks.set(target, list);
    }
  }
  return documents.map((document) => ({
    ...document,
    backlinks: backlinks.get(normalizePath(document.path)) ?? [],
  }));
}

function splitFrontmatter(content: string): {
  frontmatter: Record<string, string | readonly string[]>;
  body: string;
} {
  const normalized = content.replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---\n")) return { frontmatter: {}, body: normalized };
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return { frontmatter: {}, body: normalized };
  const yaml = normalized.slice(4, end);
  const body = normalized.slice(end + 4).replace(/^\n/, "");
  return { frontmatter: parseSimpleYaml(yaml), body };
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

function stringList(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.map(String).map(normalizeTag).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(/[,\s]+/)
      .map(normalizeTag)
      .filter(Boolean);
  }
  return [];
}

function firstHeading(body: string): string | undefined {
  const match = /^#\s+(.+?)\s*#*\s*$/m.exec(body);
  return match?.[1].trim();
}

function extractTags(body: string): readonly string[] {
  const tags = new Set<string>();
  for (const match of body.matchAll(/(?:^|\s)#([\p{L}\p{N}/_-]+)/gu)) {
    const tag = normalizeTag(match[1]);
    if (tag) tags.add(tag);
  }
  return [...tags];
}

function extractWikiLinks(body: string): readonly string[] {
  const links: string[] = [];
  for (const match of body.matchAll(/\[\[([^\]|#^]+)(?:[#^|][^\]]*)?]]/g)) {
    const target = normalizeLinkedTarget(match[1]);
    if (target) links.push(target);
  }
  return [...new Set(links)];
}

function resolveLinkedPath(link: string, byPath: Map<string, RetrievalDocument>): string | null {
  const normalized = normalizePath(link);
  if (byPath.has(normalized)) return normalized;
  const withExtension = normalized.endsWith(".md") ? normalized : `${normalized}.md`;
  if (byPath.has(withExtension)) return withExtension;
  const basenameMatch = [...byPath.keys()].find((path) => path.split("/").pop()?.replace(/\.md$/i, "") === normalized);
  return basenameMatch ?? null;
}

function normalizeLinkedTarget(target: string): string | undefined {
  const trimmed = target.trim().replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+/g, "/");
  return trimmed || undefined;
}

function normalizeTag(value: string): string {
  return value.trim().replace(/^#/, "").toLowerCase();
}

function normalizePath(path: string): string {
  return path.trim().replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+/g, "/").toLowerCase();
}
