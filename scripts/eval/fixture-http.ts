import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** Shared lifecycle and CLI plumbing for the local eval fixture servers. */

/**
 * Host the fixture servers advertise. Never use a literal loopback IP here:
 * the eval provider redacts `127.0.0.1` in tool arguments to `[IP_ADDRESS]`,
 * so `fetch_url` would fail before it reaches the server. `localhost` survives.
 */
export const FIXTURE_HOST = "localhost";
/**
 * Listener host. The IPv6 wildcard is dual-stack by default, so it accepts
 * `localhost` whether the client resolves it to `::1` or to `127.0.0.1`. It is
 * not loopback-only; the fixture serves static test data on an ephemeral port
 * and closes after the run.
 */
export const FIXTURE_BIND_HOST = "::";
const FIXTURE_IPV4_FALLBACK_HOST = "127.0.0.1";
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
): Promise<LocalHttpServer> {
  const server = createServer((request, response) => {
    try {
      const result = handler(request, response);
      if (result) void result.catch(() => failRequest(response));
    } catch {
      failRequest(response);
    }
  });
  return new Promise((resolve, reject) => {
    // A host without IPv6 (some CI sandboxes) cannot bind the dual-stack
    // wildcard. There `localhost` resolves to 127.0.0.1, so bind that instead.
    const listen = (host: string) => server.listen(options.port ?? 0, host, onListening);
    const onError = (error: NodeJS.ErrnoException) => {
      if (error.code === "EAFNOSUPPORT" && !server.listening) {
        server.once("error", reject);
        listen(FIXTURE_IPV4_FALLBACK_HOST);
        return;
      }
      reject(error);
    };
    server.once("error", onError);
    const onListening = () => {
      server.removeListener("error", onError);
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
    };
    listen(FIXTURE_BIND_HOST);
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

export interface FixtureCliArgs<Flag extends string> {
  port?: number;
  json: boolean;
  /** The server's own integer flags, for example `slow-ms` or `tools`. */
  flags: Partial<Record<Flag, number>>;
}

function parseFixtureCliArgs<Flag extends string>(argv: string[], flags: readonly Flag[]): FixtureCliArgs<Flag> {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: "string" },
      json: { type: "boolean" },
      ...Object.fromEntries(flags.map((flag) => [flag, { type: "string" as const }])),
    },
  }) as { values: Record<string, string | boolean | undefined> };
  const integer = (name: string): number | undefined => {
    const value = values[name];
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (typeof value !== "string" || !Number.isInteger(parsed) || parsed < 0) {
      throw new Error(`--${name} needs a non-negative integer`);
    }
    return parsed;
  };
  const parsedFlags: Partial<Record<Flag, number>> = {};
  for (const flag of flags) parsedFlags[flag] = integer(flag);
  return { port: integer("port"), json: values.json === true, flags: parsedFlags };
}

/**
 * When the module is the process entry point: parse `--port`, `--json`, and the
 * server's own integer flags, print the endpoint, and serve until SIGINT or
 * SIGTERM. Does nothing when the module is imported.
 */
export function runFixtureCli<Flag extends string>(
  metaUrl: string,
  flags: readonly Flag[],
  start: (args: FixtureCliArgs<Flag>) => Promise<LocalHttpServer>,
): void {
  const entry = process.argv[1];
  if (!entry || metaUrl !== pathToFileURL(entry).href) return;
  void (async () => {
    const args = parseFixtureCliArgs(process.argv.slice(2), flags);
    const server = await start(args);
    process.stdout.write(`${args.json ? JSON.stringify({ url: server.url, port: server.port }) : server.url}\n`);
    const stop = (): void => {
      void server.close().then(() => process.exit(0));
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  })().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
