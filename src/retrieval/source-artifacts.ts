import type { ToolArtifactMetadata, ToolArtifactStoreLike } from "../artifacts/tool-artifact-store";
import { formatSourceReference } from "./citations";
import { formatFrontmatterScalar, parseFrontmatterFields } from "./frontmatter";
import { legacyStableTextHash, stableTextHash } from "./source-hash";
import { findExistingSourceArtifact } from "./source-artifact-dedupe";

export const SOURCE_IMPORT_CONTENT_TYPE = "text/markdown; charset=utf-8";
export const SOURCE_IMPORT_SOURCE_TOOL = "agentic-chat.source-import";

export type SourceImportKind = "web" | "transcript" | "video";
export type SourceTextExtractor = "readability-lite" | "regex-fallback" | "plain-text" | "transcript-lite";

export interface ReadableSource {
  title: string;
  text: string;
  extractor: SourceTextExtractor;
  sourceKind: SourceImportKind;
  mediaUrl?: string;
}

export interface SourceImportProvenance {
  url: string;
  finalUrl?: string;
  title?: string;
  contentType?: string;
  extractor: SourceTextExtractor;
  sourceKind: SourceImportKind;
  mediaUrl?: string;
  transcriptFormat?: string;
  importedAt: string;
  dedupKey: string;
  textHash: string;
  sourceTextChars: number;
}

export interface SourceImportWriteInput {
  url: string;
  finalUrl?: string;
  title?: string;
  text: string;
  contentType?: string;
  extractor: SourceTextExtractor;
  sourceKind?: SourceImportKind;
  mediaUrl?: string;
  transcriptFormat?: string;
  importedAt?: string;
}

export interface SourceImportWriteResult {
  metadata: ToolArtifactMetadata;
  provenance: SourceImportProvenance;
  artifactCitation: string;
  urlCitation: string;
  duplicate: boolean;
  text: string;
}

interface CachedSourceImport {
  metadata: ToolArtifactMetadata;
  provenance: SourceImportProvenance;
  artifactCitation: string;
  urlCitation: string;
  text: string;
}

const CANDIDATE_TAGS = ["article", "main"];
const CANDIDATE_ATTRS = /\b(?:role\s*=\s*["']main["']|id\s*=\s*["'][^"']*(?:article|content|entry|main|post)[^"']*["']|class\s*=\s*["'][^"']*(?:article|content|entry|main|post)[^"']*["'])/i;
const STRIP_BLOCKS = /<(script|style|noscript|template|svg|head|nav|footer|aside|form|button|select|textarea|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi;
const BLOCK_TAGS =
  /<\/?(p|div|section|article|header|main|aside|h[1-6]|li|ul|ol|tr|br|hr|table|blockquote|pre|figure|figcaption)\b[^>]*>/gi;
const READABILITY_MIN_CHARS = 20;

/**
 * Deterministic, dependency-free extraction. It prefers article/main/content
 * candidates and falls back to whole-document regex extraction when a page does
 * not expose a useful readable container.
 */
export function extractReadableSource(html: string, contentType = ""): ReadableSource {
  if (!looksLikeHtml(html, contentType)) {
    return { title: "", text: normalizeText(html), extractor: "plain-text", sourceKind: "web" };
  }

  const title = extractTitle(html);
  const video = extractVideoMetadata(html);
  const candidates = extractCandidateBlocks(html)
    .map((candidate) => ({ text: htmlToText(candidate), rawLength: candidate.length }))
    .filter((candidate) => candidate.text.length >= READABILITY_MIN_CHARS)
    .sort((left, right) => scoreCandidate(right) - scoreCandidate(left));

  if (candidates.length > 0) {
    return {
      title,
      text: candidates[0].text,
      extractor: "readability-lite",
      sourceKind: video ? "video" : "web",
      mediaUrl: video?.mediaUrl,
    };
  }

  return {
    title,
    text: htmlToText(html),
    extractor: "regex-fallback",
    sourceKind: video ? "video" : "web",
    mediaUrl: video?.mediaUrl,
  };
}

export function formatSourceImportArtifact(provenance: SourceImportProvenance, sourceText: string): string {
  const sourceCitation = formatSourceReference({
    type: "url",
    url: provenance.finalUrl ?? provenance.url,
    label: provenance.title || provenance.finalUrl || provenance.url,
  });
  const frontmatter = [
    "---",
    "agentic_chat_source: 1",
    `source_url: ${formatFrontmatterScalar(provenance.url)}`,
    provenance.finalUrl && provenance.finalUrl !== provenance.url ? `final_url: ${formatFrontmatterScalar(provenance.finalUrl)}` : null,
    provenance.title ? `title: ${formatFrontmatterScalar(provenance.title)}` : null,
    provenance.contentType ? `content_type: ${formatFrontmatterScalar(provenance.contentType)}` : null,
    `extractor: ${provenance.extractor}`,
    `source_kind: ${provenance.sourceKind}`,
    provenance.mediaUrl ? `media_url: ${formatFrontmatterScalar(provenance.mediaUrl)}` : null,
    provenance.transcriptFormat ? `transcript_format: ${formatFrontmatterScalar(provenance.transcriptFormat)}` : null,
    `imported_at: ${provenance.importedAt}`,
    `dedup_key: ${provenance.dedupKey}`,
    `text_hash: ${provenance.textHash}`,
    `source_text_chars: ${provenance.sourceTextChars}`,
    "---",
  ].filter((line): line is string => line !== null);
  const header = [
    ...frontmatter,
    "",
    `Source: ${sourceCitation}`,
    "",
    "## Extracted source text",
    "",
  ];
  return `${header.join("\n")}${sourceText.trim() || "(no readable text)"}\n`;
}

export function parseSourceImportProvenance(text: string): SourceImportProvenance | null {
  const fields = parseFrontmatterFields(text);
  if (!fields) return null;
  if (fields.get("agentic_chat_source") !== "1") return null;
  const url = fields.get("source_url");
  const extractor = fields.get("extractor");
  const sourceKind = fields.get("source_kind") || "web";
  const importedAt = fields.get("imported_at");
  const dedupKey = fields.get("dedup_key");
  const textHash = fields.get("text_hash");
  const sourceTextChars = Number(fields.get("source_text_chars"));
  if (
    !url ||
    !isSourceTextExtractor(extractor) ||
    !isSourceImportKind(sourceKind) ||
    !importedAt ||
    !dedupKey ||
    !textHash ||
    !Number.isFinite(sourceTextChars)
  ) {
    return null;
  }
  return {
    url,
    finalUrl: fields.get("final_url") || undefined,
    title: fields.get("title") || undefined,
    contentType: fields.get("content_type") || undefined,
    extractor,
    sourceKind,
    mediaUrl: fields.get("media_url") || undefined,
    transcriptFormat: fields.get("transcript_format") || undefined,
    importedAt,
    dedupKey,
    textHash,
    sourceTextChars,
  };
}

export async function writeSourceImportArtifact(
  store: ToolArtifactStoreLike,
  input: SourceImportWriteInput,
): Promise<SourceImportWriteResult> {
  return new SourceArtifactDeduper().write(store, input);
}

export class SourceArtifactDeduper {
  private readonly byKey = new Map<string, CachedSourceImport>();

  async write(store: ToolArtifactStoreLike, input: SourceImportWriteInput): Promise<SourceImportWriteResult> {
    const provenance = await createSourceImportProvenance(input);
    const cached = this.byKey.get(provenance.dedupKey);
    if (cached) return { ...cached, duplicate: true };

    const existing = await findExistingSourceArtifact(store, {
      dedupKey: provenance.dedupKey,
      textHash: provenance.textHash,
      legacyDedupKeys: [legacySourceDedupKey(input)],
      legacyTextHashes: [legacySourceTextHash(input.text)],
    });
    if (existing) {
      const artifactCitation = formatSourceReference({
        type: "artifact",
        artifactId: existing.artifact.metadata.id,
        label: input.title || input.finalUrl || input.url,
      });
      const urlCitation = formatSourceReference({
        type: "url",
        url: input.finalUrl ?? input.url,
        label: input.title || input.finalUrl || input.url,
      });
      const persistedProvenance = parseSourceImportProvenance(existing.artifact.text) ?? provenance;
      const value = {
        metadata: existing.artifact.metadata,
        provenance: persistedProvenance,
        artifactCitation,
        urlCitation,
        text: existing.artifact.text,
      };
      this.byKey.set(provenance.dedupKey, value);
      return { ...value, duplicate: true };
    }

    const text = formatSourceImportArtifact(provenance, input.text);
    const metadata = await store.writeArtifact({
      label: sourceArtifactLabel(input.title, input.finalUrl ?? input.url),
      sourceToolName: SOURCE_IMPORT_SOURCE_TOOL,
      contentType: SOURCE_IMPORT_CONTENT_TYPE,
      dedupKey: provenance.dedupKey,
      sourceUrl: input.finalUrl ?? input.url,
      sourceKind: provenance.sourceKind,
      sourceTextHash: provenance.textHash,
      text,
    });
    const artifactCitation = formatSourceReference({
      type: "artifact",
      artifactId: metadata.id,
      label: input.title || input.finalUrl || input.url,
    });
    const urlCitation = formatSourceReference({
      type: "url",
      url: input.finalUrl ?? input.url,
      label: input.title || input.finalUrl || input.url,
    });
    const value = { metadata, provenance, artifactCitation, urlCitation, text };
    this.byKey.set(provenance.dedupKey, value);
    return { ...value, duplicate: false };
  }
}

export async function createSourceImportProvenance(input: SourceImportWriteInput): Promise<SourceImportProvenance> {
  const normalizedSource = normalizeSourceUrl(input.finalUrl ?? input.url);
  const text = input.text.trim();
  const textHash = await stableTextHash(text);
  return {
    url: input.url,
    finalUrl: input.finalUrl,
    title: input.title,
    contentType: input.contentType,
    extractor: input.extractor,
    sourceKind: input.sourceKind ?? "web",
    mediaUrl: input.mediaUrl,
    transcriptFormat: input.transcriptFormat,
    importedAt: input.importedAt ?? new Date().toISOString(),
    dedupKey: `source:${normalizedSource}:${textHash}`,
    textHash,
    sourceTextChars: text.length,
  };
}

function legacySourceDedupKey(input: SourceImportWriteInput): string {
  return `source:${normalizeSourceUrl(input.finalUrl ?? input.url)}:${legacySourceTextHash(input.text)}`;
}

function legacySourceTextHash(text: string): string {
  return legacyStableTextHash(text.trim());
}

function extractTitle(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  if (title) return normalizeText(decodeEntities(stripTags(title)));
  const heading = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1];
  return heading ? normalizeText(decodeEntities(stripTags(heading))) : "";
}

function extractVideoMetadata(html: string): { mediaUrl?: string } | null {
  const ogType = metaContent(html, "og:type");
  const hasVideoType = ogType ? /^video(?:\.|$)/i.test(ogType) : false;
  const mediaUrl = metaContent(html, "og:video") ?? metaContent(html, "og:video:url") ?? metaContent(html, "twitter:player");
  if (!hasVideoType && !mediaUrl) return null;
  return { mediaUrl };
}

function metaContent(html: string, key: string): string | undefined {
  for (const match of html.matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = match[1];
    const name = attributeValue(attrs, "property") ?? attributeValue(attrs, "name");
    if (name?.toLowerCase() !== key.toLowerCase()) continue;
    const content = attributeValue(attrs, "content");
    if (content) return decodeEntities(content).trim();
  }
  return undefined;
}

function attributeValue(attrs: string, key: string): string | undefined {
  const pattern = new RegExp(`\\b${key}\\s*=\\s*["']([^"']*)["']`, "i");
  return pattern.exec(attrs)?.[1];
}

function extractCandidateBlocks(html: string): string[] {
  const candidates: string[] = [];
  for (const tag of CANDIDATE_TAGS) {
    const pattern = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
    for (const match of html.matchAll(pattern)) candidates.push(match[0]);
  }

  const genericPattern = /<([a-z][a-z0-9:-]*)\b([^>]*)>[\s\S]*?<\/\1>/gi;
  for (const match of html.matchAll(genericPattern)) {
    if (CANDIDATE_ATTRS.test(match[2])) candidates.push(match[0]);
  }
  return candidates;
}

function scoreCandidate(candidate: { text: string; rawLength: number }): number {
  const lineCount = candidate.text.split("\n").filter((line) => line.trim()).length;
  return candidate.text.length + lineCount * 25 - Math.max(0, candidate.rawLength - candidate.text.length) * 0.02;
}

function htmlToText(html: string): string {
  let body = html.replace(/<!--[\s\S]*?-->/g, " ");
  body = body.replace(STRIP_BLOCKS, " ");
  body = body.replace(BLOCK_TAGS, "\n");
  body = stripTags(body);
  body = decodeEntities(body);
  return normalizeText(body);
}

function stripTags(text: string): string {
  return text.replace(/<[^>]+>/g, " ");
}

function normalizeText(text: string): string {
  return text
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function looksLikeHtml(text: string, contentType: string): boolean {
  return /html|xml/i.test(contentType) || (!contentType && /<(!doctype html|html|head|body|p|div|a|span|h[1-6])\b/i.test(text.slice(0, 2000)));
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "\u2014",
  ndash: "\u2013",
  hellip: "\u2026",
};

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
    const lower = code.toLowerCase();
    if (lower.startsWith("#")) {
      const num = lower[1] === "x" ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(num) && num > 0 ? String.fromCodePoint(num) : match;
    }
    return NAMED_ENTITIES[lower] ?? match;
  });
}

function isSourceTextExtractor(value: string | undefined): value is SourceTextExtractor {
  return value === "readability-lite" || value === "regex-fallback" || value === "plain-text" || value === "transcript-lite";
}

function isSourceImportKind(value: string | undefined): value is SourceImportKind {
  return value === "web" || value === "transcript" || value === "video";
}

function sourceArtifactLabel(title: string | undefined, url: string): string {
  const label = title?.trim() || url;
  return `Source: ${label}`.slice(0, 160);
}

function normalizeSourceUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    url.searchParams.sort();
    return url.toString();
  } catch {
    return value.trim().toLowerCase();
  }
}
