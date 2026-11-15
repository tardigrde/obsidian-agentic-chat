import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import process from "node:process";
import { pathToFileURL } from "node:url";

export interface FixtureServerOptions {
  /** Port to bind on 127.0.0.1. Default 0: the OS assigns a free port. */
  port?: number;
  /** Delay for GET /slow in milliseconds. Default 250. */
  slowMs?: number;
}

export interface FixtureServer {
  /** Base URL, for example http://127.0.0.1:41234. */
  url: string;
  port: number;
  /** Stop the listener. Safe to call more than once. */
  close: () => Promise<void>;
}

const HOST = "127.0.0.1";
const DEFAULT_SLOW_MS = 250;
const TEXT = "text/plain; charset=utf-8";
const MARKDOWN = "text/markdown; charset=utf-8";
const JSON_TYPE = "application/json; charset=utf-8";

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

function send(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  response.end(body);
}

// Only the path and query are read. Request bodies and headers are never read
// or logged, so eval payloads stay out of the terminal.
function handleRequest(request: IncomingMessage, response: ServerResponse, slowMs: number): void {
  let url: URL;
  try {
    url = new URL(request.url ?? "/", `http://${HOST}`);
  } catch {
    // A malformed request target (for example `//[`) must not crash the
    // process that a test runner depends on.
    send(response, 400, TEXT, "Bad Request\n");
    return;
  }
  switch (url.pathname) {
    case "/article":
      send(response, 200, MARKDOWN, ARTICLE);
      return;
    case "/article-v2":
      send(response, 200, MARKDOWN, ARTICLE_V2);
      return;
    case "/redirect":
      send(response, 302, TEXT, "Redirecting to /article\n", { location: "/article" });
      return;
    case "/429":
      send(response, 429, TEXT, "Too Many Requests. Retry after 1 second.\n", { "retry-after": "1" });
      return;
    case "/slow":
      setTimeout(() => send(response, 200, TEXT, `Slow response after ${slowMs} ms.\n`), slowMs);
      return;
    case "/json":
      send(response, 200, JSON_TYPE, JSON_BODY);
      return;
    case "/echo":
      send(response, 200, TEXT, url.searchParams.get("q") ?? "");
      return;
    default:
      send(response, 404, TEXT, "Not Found\n");
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

export function startFixtureServer(options: FixtureServerOptions = {}): Promise<FixtureServer> {
  const slowMs = options.slowMs ?? DEFAULT_SLOW_MS;
  const server = createServer((request, response) => handleRequest(request, response, slowMs));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, HOST, () => {
      server.removeListener("error", reject);
      const { port } = server.address() as AddressInfo;
      let closing: Promise<void> | undefined;
      resolve({
        url: `http://${HOST}:${port}`,
        port,
        close: () => {
          closing ??= closeServer(server);
          return closing;
        },
      });
    });
  });
}

interface CliOptions {
  port?: number;
  slowMs?: number;
  json?: boolean;
}

function integerArg(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (value === undefined || !Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} needs a non-negative integer`);
  }
  return parsed;
}

function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (raw === "--json") {
      options.json = true;
      continue;
    }
    if (raw === "--port") {
      options.port = integerArg(argv[index + 1], "--port");
      index += 1;
      continue;
    }
    if (raw === "--slow-ms") {
      options.slowMs = integerArg(argv[index + 1], "--slow-ms");
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${raw}`);
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const server = await startFixtureServer({ port: options.port, slowMs: options.slowMs });
  const line = options.json ? JSON.stringify({ url: server.url, port: server.port }) : server.url;
  process.stdout.write(`${line}\n`);
  const stop = (): void => {
    void server.close().then(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
