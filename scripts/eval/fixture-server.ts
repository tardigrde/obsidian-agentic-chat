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

export interface FixtureServerOptions {
  /** Port to bind on the dual-stack wildcard listener. Default 0: the OS assigns a free port. The fixture serves static test data and closes after the run. */
  port?: number;
  /** Delay for GET /slow in milliseconds. Default 250. */
  slowMs?: number;
}

export type FixtureServer = LocalHttpServer;

const DEFAULT_SLOW_MS = 250;
const MARKDOWN = "text/markdown; charset=utf-8";

const ARTICLE = [
  "# Fixture Article",
  "",
  "Published: 2026-01-05",
  "",
  "The fixture server runs offline, so web-tool evals stay deterministic.",
  "",
].join("\n");

const ARTICLE_V2 = [
  "# Fixture Article (v2)",
  "",
  "Published: 2026-07-19",
  "",
  "This newer fixture article exists to ask which source is more recent.",
  "",
].join("\n");

const JSON_BODY = JSON.stringify({ fixture: true, items: ["alpha", "beta"], count: 2 });

// Only the path and query are read. Request bodies and headers are never read
// or logged, so eval payloads stay out of the terminal.
function handleRequest(request: IncomingMessage, response: ServerResponse, slowMs: number): void {
  const url = requestUrl(request, response);
  if (!url) return;
  switch (url.pathname) {
    case "/article":
      send(response, 200, MARKDOWN, ARTICLE);
      return;
    case "/article-v2":
      send(response, 200, MARKDOWN, ARTICLE_V2);
      return;
    case "/redirect":
      send(response, 302, TEXT_CONTENT_TYPE, "Redirecting to /article\n", { location: "/article" });
      return;
    case "/429":
      send(response, 429, TEXT_CONTENT_TYPE, "Too Many Requests. Retry after 1 second.\n", { "retry-after": "1" });
      return;
    case "/slow":
      setTimeout(() => send(response, 200, TEXT_CONTENT_TYPE, `Slow response after ${slowMs} ms.\n`), slowMs);
      return;
    case "/json":
      send(response, 200, JSON_CONTENT_TYPE, JSON_BODY);
      return;
    case "/echo":
      send(response, 200, TEXT_CONTENT_TYPE, url.searchParams.get("q") ?? "");
      return;
    default:
      send(response, 404, TEXT_CONTENT_TYPE, "Not Found\n");
  }
}

export function startFixtureServer(options: FixtureServerOptions = {}): Promise<FixtureServer> {
  const slowMs = options.slowMs ?? DEFAULT_SLOW_MS;
  return startLocalHttpServer((request, response) => handleRequest(request, response, slowMs), {
    port: options.port,
  });
}

runFixtureCli(import.meta.url, process.argv.slice(2), "--slow-ms", (args) =>
  startFixtureServer({ port: args.port, slowMs: args.extra }),
);
