import { requestUrl } from "obsidian";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

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
  return async (request) => {
    try {
      const response = await requestUrl({
        url: request.url,
        method: request.method ?? "GET",
        headers: request.headers,
        body: request.body,
        // Handle non-2xx ourselves so a 404/500 becomes a tool error the model
        // can read, not an exception that aborts the turn.
        throw: false,
      });
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(response.headers ?? {})) {
        headers[key.toLowerCase()] = String(value);
      }
      return { status: response.status, text: response.text, headers };
    } catch (error) {
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
}

const ACCEPT_HEADER = "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8";

/**
 * The `fetch_url` tool: fetch an http(s) URL and return its readable text. HTML
 * is stripped to plain text; other text types pass through. Read-only, but it
 * sends the URL off-device, so it is only registered when web access is enabled.
 */
export function createWebFetchTool(config: WebFetchConfig): AgentTool<typeof FetchParameters> {
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
      const response = await config.fetcher({ url, method: "GET", headers: { Accept: ACCEPT_HEADER } }, signal);
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
      return {
        content: [{ type: "text", text: rendered.text }],
        details: {
          url,
          title: rendered.title,
          contentType,
          offset: rendered.offset,
          nextOffset: rendered.nextOffset,
          totalChars: rendered.totalChars,
          truncated: rendered.truncated,
          hasMore: rendered.hasMore,
        },
      };
    },
  };
}

interface RenderedPage {
  title: string;
  text: string;
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
  const extracted = html ? extractReadableText(safeRaw) : { title: "", text: safeRaw };
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

function looksLikeHtml(text: string): boolean {
  return /<(!doctype html|html|head|body|p|div|a|span|h[1-6])\b/i.test(text.slice(0, 2000));
}

/** Remove these elements wholesale — their contents are never readable text. */
const STRIP_BLOCKS = /<(script|style|noscript|template|svg|head|nav|footer)\b[^>]*>[\s\S]*?<\/\1>/gi;
/** Block-level tags converted to a line break so paragraphs don't run together. */
const BLOCK_TAGS =
  /<\/?(p|div|section|article|header|main|aside|h[1-6]|li|ul|ol|tr|br|hr|table|blockquote|pre|figure)\b[^>]*>/gi;

/**
 * Extract a page title and readable body text from raw HTML, deterministically
 * and without a DOM (works in tests and on mobile). Best-effort: strips
 * scripts/styles/markup, decodes common entities, and collapses whitespace.
 */
export function extractReadableText(html: string): { title: string; text: string } {
  const title = decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").trim());
  let body = html.replace(/<!--[\s\S]*?-->/g, " ");
  body = body.replace(STRIP_BLOCKS, " ");
  body = body.replace(BLOCK_TAGS, "\n");
  body = body.replace(/<[^>]+>/g, " ");
  body = decodeEntities(body);
  body = body.replace(/[ \t\f\v\r]+/g, " ");
  body = body.replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { title, text: body };
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
};

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
    const lower = code.toLowerCase();
    if (lower[0] === "#") {
      const num = lower[1] === "x" ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(num) && num > 0 ? String.fromCodePoint(num) : match;
    }
    return NAMED_ENTITIES[lower] ?? match;
  });
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

/** Throw if the run was aborted (requestUrl itself takes no signal). */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Aborted.");
}
