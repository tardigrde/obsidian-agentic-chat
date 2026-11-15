import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import process from "node:process";
import { pathToFileURL } from "node:url";

/** Shared lifecycle and CLI plumbing for the local eval fixture servers. */

/**
 * Host the fixture servers advertise. Never use a literal loopback IP here:
 * the eval provider redacts `127.0.0.1` in tool arguments to `[IP_ADDRESS]`,
 * so `fetch_url` would fail before it reaches the server. `localhost` survives.
 */
export const FIXTURE_HOST = "localhost";
/**
 * Listener host. The IPv6 wildcard is dual-stack by default, so it accepts
 * `localhost` whether the client resolves it to `::1` or to `127.0.0.1`.
 */
export const FIXTURE_BIND_HOST = "::";
export const TEXT_CONTENT_TYPE = "text/plain; charset=utf-8";
export const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

export interface LocalHttpServer {
  /** Base URL with the optional path already appended. */
  url: string;
  port: number;
  /** Stop the listener. Safe to call more than once. */
  close: () => Promise<void>;
}

export function send(
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

/** Parse the request target and answer 400 when it is malformed. */
export function requestUrl(request: IncomingMessage, response: ServerResponse): URL | undefined {
  try {
    return new URL(request.url ?? "/", `http://${FIXTURE_HOST}`);
  } catch {
    // A malformed request target (for example `//[`) must not crash the
    // process that a test runner depends on.
    send(response, 400, TEXT_CONTENT_TYPE, "Bad Request\n");
    return undefined;
  }
}

export function startLocalHttpServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
  options: { port?: number; path?: string } = {},
): Promise<LocalHttpServer> {  const server = createServer((request, response) => {
    try {
      const result = handler(request, response);
      if (result) void result.catch(() => failRequest(response));
    } catch {
      failRequest(response);
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, FIXTURE_BIND_HOST, () => {
      server.removeListener("error", reject);
      const { port } = server.address() as AddressInfo;
      let closing: Promise<void> | undefined;
      resolve({
        url: `http://${FIXTURE_HOST}:${port}${options.path ?? ""}`,
        port,
        close: () => {
          closing ??= closeServer(server);
          return closing;
        },
      });
    });
  });
}

function failRequest(response: ServerResponse): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  send(response, 500, TEXT_CONTENT_TYPE, "Internal Server Error\n");
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

export interface FixtureCliArgs {
  port?: number;
  json?: boolean;
  /** Value of the server-specific integer flag, for example --slow-ms or --tools. */
  extra?: number;
}

function integerArg(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (value === undefined || !Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} needs a non-negative integer`);
  }
  return parsed;
}

function parseFixtureCliArgs(argv: string[], extraFlag: string): FixtureCliArgs {
  const args: FixtureCliArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (raw === "--json") {
      args.json = true;
      continue;
    }
    if (raw === "--port") {
      args.port = integerArg(argv[index + 1], "--port");
      index += 1;
      continue;
    }
    if (raw === extraFlag) {
      args.extra = integerArg(argv[index + 1], extraFlag);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${raw}`);
  }
  return args;
}

/** Print the endpoint and keep the process alive until SIGINT or SIGTERM. */
function serveCli(server: LocalHttpServer, json: boolean | undefined): void {
  const line = json ? JSON.stringify({ url: server.url, port: server.port }) : server.url;
  process.stdout.write(`${line}\n`);
  const stop = (): void => {
    void server.close().then(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

function isCliEntry(metaUrl: string): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && metaUrl === pathToFileURL(entry).href;
}

function exitOnCliError(error: unknown): never {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

/**
 * Parse the fixture CLI flags, print the endpoint, and wait for a stop signal.
 * Does nothing when the module is imported instead of run as a script.
 */
export function runFixtureCli(
  metaUrl: string,
  argv: string[],
  extraFlag: string,
  start: (args: FixtureCliArgs) => Promise<LocalHttpServer>,
): void {
  if (!isCliEntry(metaUrl)) return;
  const args = parseFixtureCliArgs(argv, extraFlag);
  void start(args)
    .then((server) => serveCli(server, args.json))
    .catch(exitOnCliError);
}
