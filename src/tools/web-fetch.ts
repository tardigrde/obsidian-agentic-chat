import { requestUrl } from "obsidian";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { ToolArtifactStoreLike } from "../artifacts/tool-artifact-store";
import {
  SourceArtifactDeduper,
  extractReadableSource,
  looksLikeHtml,
  type SourceImportKind,
  type SourceTextExtractor,
} from "../retrieval/source-artifacts";
import { isHostAllowedByAllowlist } from "./web-allowlist";
import { untrustedToolResult } from "./result";
import { errorMessage } from "../utils/errors";
import { isPrivateNetworkHost } from "../utils/host-policy";
export { isHostAllowedByAllowlist, normalizeAllowedHosts } from "./web-allowlist";

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

/** A binary HTTP response, for `download_file`. */
export interface WebBinaryResponse {
  status: number;
  bytes: ArrayBuffer;
  /** Response headers, keyed by lowercased name. */
  headers: Record<string, string>;
  /** The error message when the request itself failed (status 0). */
  errorText?: string;
}

/** Like {@link WebFetcher}, but returns the raw bytes. Injected so tests never hit the network. */
export type WebBinaryFetcher = (request: WebHttpRequest, signal?: AbortSignal) => Promise<WebBinaryResponse>;

/** Production binary fetcher over Obsidian's `requestUrl` (mobile-safe; no Node API). */
export function createObsidianBinaryFetcher(): WebBinaryFetcher {
  return async (request, signal) => {
    throwIfAborted(signal);
    try {
      const response = await withAbortSignal(requestUrl({ url: request.url, method: request.method ?? "GET", headers: request.headers, throw: false }), signal);
      throwIfAborted(signal);
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(response.headers ?? {})) headers[key.toLowerCase()] = String(value);
      return { status: response.status, bytes: response.arrayBuffer, headers };
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error;
      return { status: 0, bytes: new ArrayBuffer(0), headers: {}, errorText: errorMessage(error) };
    }
  };
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
      return { status: 0, text: errorMessage(error), headers: {} };
    }
  };
}

const FetchParameters = Type.Object({
  url: Type.String({ description: "http(s) URL" }),
  offset: Type.Optional(
    Type.Number({
      description: "char offset; use returned nextOffset to page through truncated text",
    }),
  ),
  maxChars: Type.Optional(
    Type.Number({ description: "max chars to return" }),
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
  /** Comma-separated host suffix allowlist; empty allows all public hosts. */
  allowedHosts?: string;
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
 * so this loop is a no-op for them — allowlist/SSRF on auto-followed hops is
 * best-effort; the initial URL is still gated and manual fetchers (tests, custom
 * WebFetcher) are fully hop-validated.
 */
async function fetchFollowingRedirects(
  fetcher: WebFetcher,
  url: string,
  signal: AbortSignal | undefined,
  allowedHosts: string = "",
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
    if (!isHostAllowedByAllowlist(new URL(currentUrl).hostname, allowedHosts)) {
      throw new Error(`Blocked by allowlist: ${new URL(currentUrl).hostname}`);
    }
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
      "Fetch an http(s) URL and return readable text (HTML stripped). " +
      "Read a web_search result or a URL the user gave. Sends the URL off-device; cite it for any claim. " +
      "If an allowlist is configured, only hosts in the allowlist are reachable.",
    parameters: FetchParameters,
    execute: async (_id, params, signal) => {
      const url = normalizeWebUrl(params.url);
      if (!isHostAllowedByAllowlist(new URL(url).hostname, config.allowedHosts ?? "")) {
        throw new Error(`Blocked by allowlist: ${new URL(url).hostname}`);
      }
      throwIfAborted(signal);
      const response = await fetchFollowingRedirects(config.fetcher, url, signal, config.allowedHosts ?? "");
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
      // A cookie or bot wall is not the page: fail, and store no artifact (U4 #15).
      const wall = detectWall(rendered.sourceText);
      if (wall) {
        throw new Error(`Could not read ${url}: the site returned a ${wall} instead of the page. Try another source.`);
      }
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
      const duplicateHint = artifact?.duplicate ? " (already imported)" : "";
      const artifactText = artifact
        ? `${rendered.text}\n\nSource artifact: ${artifact.artifactCitation}${duplicateHint}`
        : rendered.text;
      return untrustedToolResult(
        artifactText,
        {
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
        "fetch_url",
      );
    },
  };
}

/** Short pages that are a wall in front of the content, and what kind. */
const WALL_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/cookies? (?:must|need to|have to) be (?:enabled|turned on)|enable cookies|cookies are (?:disabled|blocked)/i, "cookie wall"],
  [/(?:enable|turn on) javascript|javascript is (?:disabled|required|not enabled)|requires javascript/i, "JavaScript wall"],
  [/are you a robot|verify (?:that )?you are (?:a )?human|captcha|checking your browser|unusual traffic|access denied|request blocked/i, "bot check"],
  [/subscribe to (?:continue|read)|this content is for subscribers|sign in to (?:continue|read)/i, "paywall"],
];
/** A real article is longer than this; a wall page is short. */
const WALL_MAX_CHARS = 1_500;

export function detectWall(text: string): string | null {
  const body = text.trim();
  if (body.length > WALL_MAX_CHARS) return null;
  for (const [pattern, kind] of WALL_PATTERNS) if (pattern.test(body)) return kind;
  return null;
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
  const html = looksLikeHtml(raw, contentType);
  // Don't dump decoded binary (images, archives, PDFs) at the model — wasteful and unreadable.
  if (!html && contentType && !isTextContentType(contentType)) {
    return {
      title: "",
      text: `Source: ${url}\n\n[Skipped: "${contentType}" is not text. fetch_url only returns readable text.${binaryHint(contentType)}]`,
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
  let extracted: ReturnType<typeof extractReadableSource> | ReturnType<typeof extractTranscriptSource> | {
    title: string;
    text: string;
    extractor: "plain-text";
    sourceKind: "web";
    mediaUrl: undefined;
    transcriptFormat: undefined;
  };
  if (isTranscriptSource(url, contentType)) {
    extracted = extractTranscriptSource(safeRaw, contentType);
  } else if (html) {
    extracted = extractReadableSource(safeRaw, contentType);
  } else {
    extracted = {
      title: "",
      text: safeRaw,
      extractor: "plain-text",
      sourceKind: "web",
      mediaUrl: undefined,
      transcriptFormat: undefined,
    };
  }
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

/**
 * Validate and normalize a URL for the model-driven `fetch_url` tool. Rejects
 * non-http(s) schemes and obvious internal targets (localhost, loopback,
 * private/link-local IPs) as best-effort SSRF defense — the model can be steered
 * by a fetched page's content, so it should not be able to probe the local
 * network. This is hostname/literal-IP based; it cannot stop DNS rebinding.
 *
 * The e2e build (and only that build) can allow one loopback origin for the
 * eval fixture server; see `evalFixtureOrigin`.
 */
/** For a document type, the way to read it: save it, then import it. */
function binaryHint(contentType: string): string {
  return /pdf|epub|officedocument|msword|ms-excel|ms-powerpoint/i.test(contentType)
    ? " To read this file, save it with download_file, then use import_document."
    : "";
}

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
  if (isPrivateNetworkHost(parsed.hostname) && parsed.origin !== evalFixtureOrigin()) {
    throw new Error(`Refusing to fetch a local or private address: ${parsed.hostname}`);
  }
  return parsed.toString();
}

/** Set by `scripts/build.mjs`: true only in the e2e build, never in a release. */
declare const __AGENTIC_CHAT_ENABLE_E2E_STREAM__: boolean | undefined;

/**
 * The one loopback origin the eval harness owns, or `undefined`.
 *
 * The eval spec sets `window.__AGENTIC_CHAT_EVAL_FIXTURE_ORIGIN__` to the
 * origin of its local fixture server. Only the e2e build reads it: in a
 * release build the flag below is the constant `false`, so the bundler drops
 * the read and no window global can relax the SSRF gate.
 * `scripts/verify-mobile-compat.mjs` fails a release bundle that still
 * contains the hook name.
 */
function evalFixtureOrigin(): string | undefined {
  if (typeof __AGENTIC_CHAT_ENABLE_E2E_STREAM__ === "undefined" || !__AGENTIC_CHAT_ENABLE_E2E_STREAM__) {
    return undefined;
  }
  const origin = (window as { __AGENTIC_CHAT_EVAL_FIXTURE_ORIGIN__?: unknown }).__AGENTIC_CHAT_EVAL_FIXTURE_ORIGIN__;
  return typeof origin === "string" && origin.length > 0 ? origin : undefined;
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
