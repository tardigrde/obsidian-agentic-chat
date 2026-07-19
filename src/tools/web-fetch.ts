import { requestUrl } from "obsidian";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { ToolArtifactStoreLike } from "../artifacts/tool-artifact-store";
import {
  SourceArtifactDeduper,
  extractReadableSource,
  type SourceImportKind,
  type SourceTextExtractor,
} from "../retrieval/source-artifacts";

/** A minimal HTTP request the web tools issue. */
export interface WebHttpRequest {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  /** Already-serialized request body for POST. */
  body?: string;
}

/** A minimal HTTP response the web tools consume. */
export interface WebHttpResponse {
  status: number;
  /** Raw response body as text. */
  text: string;
  /** Response headers, keyed by lowercased name. */
  headers: Record<string, string>;
}

/**
 * Issues an HTTP request for the web tools. Injected so tests never hit the
 * network; production wraps Obsidian's `requestUrl`, which is mobile-safe and
 * not subject to CORS (unlike `fetch` inside a renderer).
 */
export type WebFetcher = (request: WebHttpRequest, signal?: AbortSignal) => Promise<WebHttpResponse>;

/** Production fetcher over Obsidian's `requestUrl`. */
export function createObsidianFetcher(): WebFetcher {
  return async (request, signal) => {
    throwIfAborted(signal);
    try {
      const response = await withAbortSignal(
        requestUrl({
          url: request.url,
          method: request.method ?? "GET",
          headers: request.headers,
          body: request.body,
          // Handle non-2xx ourselves so a 404/500 becomes a tool error the model
          // can read, not an exception that aborts the turn.
          throw: false,
        }),
        signal,
      );
      throwIfAborted(signal);
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(response.headers ?? {})) {
        headers[key.toLowerCase()] = String(value);
      }
      return { status: response.status, text: response.text, headers };
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error;
      // Offline / DNS failure / TLS error: surface as status 0 with the message
      // so the tool reports a clean error instead of crashing the agent turn.
      return { status: 0, text: error instanceof Error ? error.message : String(error), headers: {} };
    }
  };
}

const FetchParameters = Type.Object({
  url: Type.String({ description: "Absolute http(s) URL to fetch" }),
  offset: Type.Optional(
    Type.Number({
      description:
        "Character offset into the extracted readable text. Use the returned nextOffset to read the next window of a truncated page.",
    }),
  ),
  maxChars: Type.Optional(
    Type.Number({ description: "Maximum characters of extracted text to return" }),
  ),
});

export interface WebFetchConfig {
  fetcher: WebFetcher;
  /** Default cap on returned characters. */
  charLimit: number;
  /** Optional artifact store used to persist full source imports for citation. */
  artifactStore?: ToolArtifactStoreLike;
  /** Optional shared dedupe cache for fetched source imports. */
  sourceArtifacts?: SourceArtifactDeduper;
}

const ACCEPT_HEADER = "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8";

/** Redirect status codes that carry a `Location` header. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Cap on redirect hops fetch_url will follow while re-validating each target. */
const MAX_REDIRECTS = 5;

/**
 * Fetch a URL, following redirects manually so each hop's target is re-checked
 * against {@link normalizeWebUrl}. `normalizeWebUrl` only validates the initial
 * host, but a public page can 3xx to a local/private address; re-validating every
 * hop keeps redirect-based SSRF from slipping past that gate. Fetchers that
 * already follow redirects (Obsidian's `requestUrl`) return a non-3xx response,
 * so this loop is a no-op for them.
 */
async function fetchFollowingRedirects(
  fetcher: WebFetcher,
  url: string,
  signal: AbortSignal | undefined,
): Promise<WebHttpResponse> {
  let currentUrl = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    throwIfAborted(signal);
    const response = await fetcher({ url: currentUrl, method: "GET", headers: { Accept: ACCEPT_HEADER } }, signal);
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers["location"];
    if (!location) return response;
    let resolved: string;
    try {
      resolved = new URL(location, currentUrl).toString();
    } catch {
      throw new Error(`Redirect from ${currentUrl} pointed at an invalid URL: ${location}`);
    }
    currentUrl = normalizeWebUrl(resolved);
  }
  throw new Error(`Too many redirects while fetching ${url}.`);
}

/**
 * The `fetch_url` tool: fetch an http(s) URL and return its readable text. HTML
 * is stripped to plain text; other text types pass through. Read-only, but it
 * sends the URL off-device, so it is only registered when web access is enabled.
 */
export function createWebFetchTool(config: WebFetchConfig): AgentTool<typeof FetchParameters> {
  const sourceArtifacts = config.sourceArtifacts ?? new SourceArtifactDeduper();
  return {
    name: "fetch_url",
    label: "Fetch web page",
    description:
      "Fetch an http(s) URL and return its readable text (HTML is stripped to plain text). " +
      "Use it to read a result from web_search, or a URL the user gave you. " +
      "Sends the URL off-device. Cite the source URL for any claim you draw from a page.",
    parameters: FetchParameters,
    execute: async (_id, params, signal) => {
      const url = normalizeWebUrl(params.url);
      throwIfAborted(signal);
      const response = await fetchFollowingRedirects(config.fetcher, url, signal);
      throwIfAborted(signal);
      if (response.status === 0) {
        throw new Error(`Could not fetch ${url}: ${response.text || "network error"}.`);
      }
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Could not fetch ${url} (HTTP ${response.status}).`);
      }
      const limit = clampCharLimit(params.maxChars, config.charLimit);
      const offset = clampOffset(params.offset);
      const contentType = response.headers["content-type"] ?? "";
      const rendered = renderFetched(url, response.text, contentType, limit, offset);
      const artifact =
        config.artifactStore && rendered.sourceText
          ? await sourceArtifacts.write(config.artifactStore, {
              url,
              title: rendered.title || undefined,
              text: rendered.sourceText,
              contentType,
              extractor: rendered.extractor,
              sourceKind: rendered.sourceKind,
              mediaUrl: rendered.mediaUrl,
              transcriptFormat: rendered.transcriptFormat,
            })
          : null;
      const artifactText = artifact
        ? `${rendered.text}\n\nSource artifact: ${artifact.artifactCitation}${
            artifact.duplicate ? " (already imported)" : ""
          }`
        : rendered.text;
      return {
        content: [{ type: "text", text: artifactText }],
        details: {
          url,
          title: rendered.title,
          contentType,
          extractor: rendered.extractor,
          sourceKind: rendered.sourceKind,
          mediaUrl: rendered.mediaUrl,
          transcriptFormat: rendered.transcriptFormat,
          offset: rendered.offset,
          nextOffset: rendered.nextOffset,
          totalChars: rendered.totalChars,
          truncated: rendered.truncated,
          hasMore: rendered.hasMore,
          sourceArtifactId: artifact?.metadata.id,
          sourceArtifactCitation: artifact?.artifactCitation,
          sourceArtifactDuplicate: artifact?.duplicate,
          sourceDedupKey: artifact?.provenance.dedupKey,
        },
      };
    },
  };
}

interface RenderedPage {
  title: string;
  text: string;
  sourceText: string;
  extractor: SourceTextExtractor;
  sourceKind: SourceImportKind;
  mediaUrl?: string;
  transcriptFormat?: string;
  offset: number;
  nextOffset: number | null;
  totalChars: number;
  truncated: boolean;
  hasMore: boolean;
}

/** Cap on raw bytes fed to the regex extractor, so a huge page can't freeze the UI. */
const MAX_RAW_CHARS = 500_000;

function renderFetched(url: string, raw: string, contentType: string, limit: number, offset: number): RenderedPage {
  const html = /html|xml/i.test(contentType) || (!contentType && looksLikeHtml(raw));
  // Don't dump decoded binary (images, archives, PDFs) at the model — wasteful and unreadable.
  if (!html && contentType && !isTextContentType(contentType)) {
    return {
      title: "",
      text: `Source: ${url}\n\n[Skipped: "${contentType}" is not text. fetch_url only returns readable text.]`,
      sourceText: "",
      extractor: "plain-text",
      sourceKind: "web",
      offset: 0,
      nextOffset: null,
      totalChars: 0,
      truncated: false,
      hasMore: false,
    };
  }
  // Bound the input before the regex passes; note when we had to clip it.
  const clipped = raw.length > MAX_RAW_CHARS;
  const safeRaw = clipped ? raw.slice(0, MAX_RAW_CHARS) : raw;
  const extracted = isTranscriptSource(url, contentType)
    ? extractTranscriptSource(safeRaw, contentType)
    : html
      ? extractReadableSource(safeRaw, contentType)
      : {
          title: "",
          text: safeRaw,
          extractor: "plain-text" as const,
          sourceKind: "web" as const,
          mediaUrl: undefined,
          transcriptFormat: undefined,
        };
  const body = extracted.text.trim();
  const start = Math.min(offset, body.length);
  const end = Math.min(start + limit, body.length);
  const hasMoreExtractedText = end < body.length;
  const hasMore = hasMoreExtractedText || clipped;
  const sliced = body.slice(start, end);
  const nextOffset = hasMoreExtractedText ? end : null;
  const truncated = hasMore;
  const header = extracted.title ? `# ${extracted.title}\nSource: ${url}` : `Source: ${url}`;
  const range = body.length > 0 ? `\n\n[Showing extracted text characters ${start}-${end} of ${body.length}.]` : "";
  const nextNote = nextOffset !== null ? ` Fetch again with offset ${nextOffset} for the next window.` : "";
  const clippedNote = clipped
    ? " Raw page text was clipped before extraction; additional source content may remain unavailable."
    : "";
  const note = truncated ? `\n\n[Page text truncated at ${limit} characters.${nextNote}${clippedNote}]` : "";
  return {
    title: extracted.title,
    text: `${header}${range}\n\n${sliced || "(no readable text)"}${note}`,
    sourceText: body,
    extractor: extracted.extractor,
    sourceKind: extracted.sourceKind,
    mediaUrl: extracted.mediaUrl,
    transcriptFormat: "transcriptFormat" in extracted ? extracted.transcriptFormat : undefined,
    offset: start,
    nextOffset,
    totalChars: body.length,
    truncated,
    hasMore,
  };
}

/** Text-ish content types fetch_url will return as-is (besides HTML/XML). */
function isTextContentType(contentType: string): boolean {
  return /text\/|json|xml|markdown|javascript|ecmascript|csv|x-yaml|yaml/i.test(contentType);
}

function isTranscriptSource(url: string, contentType: string): boolean {
  return /\b(?:text\/vtt|application\/x-subrip)\b/i.test(contentType) || /\.(vtt|srt)(?:[?#]|$)/i.test(url);
}

function extractTranscriptSource(
  raw: string,
  contentType: string,
): {
  title: string;
  text: string;
  extractor: "transcript-lite";
  sourceKind: "transcript";
  mediaUrl?: string;
  transcriptFormat: string;
} {
  const format = /\bsrt\b|x-subrip/i.test(contentType) ? "srt" : "vtt";
  return {
    title: "",
    text: normalizeTranscriptText(raw),
    extractor: "transcript-lite",
    sourceKind: "transcript",
    transcriptFormat: format,
  };
}

function normalizeTranscriptText(raw: string): string {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^WEBVTT(?:\s|$)/i.test(line))
    .filter((line) => !/^\d+$/.test(line))
    .filter((line) => !/^\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s+-->\s+\d{1,2}:\d{2}:\d{2}[,.]\d{3}/.test(line))
    .filter((line) => !/^\d{2}:\d{2}[,.]\d{3}\s+-->\s+\d{2}:\d{2}[,.]\d{3}/.test(line))
    .filter((line) => !/^NOTE(?:\s|$)/i.test(line))
    .map((line) => line.replace(/<[^>]+>/g, " "))
    .join("\n")
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function looksLikeHtml(text: string): boolean {
  return /<(!doctype html|html|head|body|p|div|a|span|h[1-6])\b/i.test(text.slice(0, 2000));
}

/**
 * Extract a page title and readable body text from raw HTML, deterministically
 * and without a DOM (works in tests and on mobile). Best-effort: strips
 * scripts/styles/markup, decodes common entities, and collapses whitespace.
 */
export function extractReadableText(html: string): { title: string; text: string } {
  const extracted = extractReadableSource(html, "text/html");
  return { title: extracted.title, text: extracted.text };
}

/**
 * Validate and normalize a URL for the model-driven `fetch_url` tool. Rejects
 * non-http(s) schemes and obvious internal targets (localhost, loopback,
 * private/link-local IPs) as best-effort SSRF defense — the model can be steered
 * by a fetched page's content, so it should not be able to probe the local
 * network. This is hostname/literal-IP based; it cannot stop DNS rebinding.
 */
export function normalizeWebUrl(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    throw new Error(`Invalid URL: ${input}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Only http(s) URLs can be fetched: ${input}`);
  }
  if (isBlockedHost(parsed.hostname)) {
    throw new Error(`Refusing to fetch a local or private address: ${parsed.hostname}`);
  }
  return parsed.toString();
}

function isBlockedHost(hostname: string): boolean {
  let host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1) would otherwise slip past the IPv4
  // checks. The WHATWG URL parser serializes these to hex (::ffff:7f00:1), so
  // accept both forms and re-check the embedded IPv4 address.
  const mapped = /^(?:0*:)*ffff:(.+)$/.exec(host);
  if (mapped) {
    const embedded = mappedToIpv4(mapped[1]);
    if (embedded) host = embedded;
  }
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "" || host === "0.0.0.0" || host === "::" || host === "::1") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd][0-9a-f]*:/.test(host)) return true;
  if (/^fe[89ab][0-9a-f]*:/.test(host)) return true;
  return false;
}

/**
 * Convert the tail of an IPv4-mapped IPv6 address to dotted IPv4, accepting both
 * the dotted form (`127.0.0.1`) and the two-hextet form (`7f00:1`) the URL
 * parser normalizes to. Returns undefined when it isn't a recognizable IPv4.
 */
function mappedToIpv4(tail: string): string | undefined {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(tail)) return tail;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
  if (!hex) return undefined;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return [(high >> 8) & 255, high & 255, (low >> 8) & 255, low & 255].join(".");
}

/** Cap returned characters between a sane floor and the configured default. */
function clampCharLimit(requested: number | undefined, fallback: number): number {
  const value = Number.isFinite(requested) && (requested as number) > 0 ? Math.floor(requested as number) : fallback;
  return Math.min(Math.max(value, 500), 100_000);
}

/** Cap offsets to non-negative integer positions in the extracted text. */
function clampOffset(requested: number | undefined): number {
  return Number.isFinite(requested) && (requested as number) > 0 ? Math.floor(requested as number) : 0;
}

/** Throw when a tool run has already been cancelled. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Aborted.");
}

function withAbortSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  let abortListener: (() => void) | undefined;
  const abortPromise = new Promise<T>((_, reject) => {
    abortListener = () => reject(new Error("Aborted."));
    signal.addEventListener("abort", abortListener, { once: true });
  });
  return Promise.race([promise, abortPromise]).finally(() => {
    if (abortListener) signal.removeEventListener("abort", abortListener);
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && /aborted/i.test(error.message);
}
