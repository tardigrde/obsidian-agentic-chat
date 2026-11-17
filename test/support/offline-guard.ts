import net from "node:net";

/**
 * T1 is hermetic: a unit test may talk to a local fake (127.0.0.1, ::1,
 * localhost), never to the network. This guard makes a remote call fail loudly
 * instead of passing on a good connection and flaking on a bad one.
 *
 * It wraps `fetch` and `net.Socket#connect` (which http, https, undici, and the
 * MCP SDK all reach). A test that needs a remote-looking URL injects a fake
 * fetcher; it never reaches this guard.
 */

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

export class OfflineGuardError extends Error {
  constructor(target: string) {
    super(`offline guard: a T1 test tried to reach ${target}. Inject a fake fetcher or use a local server on 127.0.0.1.`);
    this.name = "OfflineGuardError";
  }
}

export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return true; // a path-only socket (IPC) or a default local connect
  const bare = host.toLowerCase();
  return LOOPBACK.has(bare) || bare.startsWith("127.") || bare.endsWith(".localhost");
}

function hostOf(input: unknown): string | undefined {
  try {
    if (typeof input === "string") return new URL(input).hostname;
    if (input instanceof URL) return input.hostname;
    if (input && typeof input === "object" && "url" in input) return new URL(String((input as { url: string }).url)).hostname;
  } catch {
    return undefined;
  }
  return undefined;
}

let installed = false;

export function installOfflineGuard(): void {
  if (installed || process.env.AGENTIC_CHAT_TEST_ALLOW_NETWORK === "1") return;
  installed = true;

  const realFetch = globalThis.fetch;
  if (typeof realFetch === "function") {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const host = hostOf(input);
      if (!isLoopbackHost(host)) throw new OfflineGuardError(String(host));
      return realFetch(input, init);
    }) as typeof fetch;
  }

  const proto = net.Socket.prototype as unknown as { connect: (...args: unknown[]) => unknown };
  const realConnect = proto.connect;
  proto.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
    // net.connect() hands Socket#connect its normalized args as one array.
    const [first, second] = Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
    let host: string | undefined;
    if (first && typeof first === "object") {
      const options = first as { host?: string; path?: string };
      host = options.path ? undefined : options.host;
    } else if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) {
      host = typeof second === "string" ? second : undefined;
    }
    if (!isLoopbackHost(host)) {
      const error = new OfflineGuardError(`${host}`);
      process.nextTick(() => this.destroy(error));
      return this;
    }
    return realConnect.apply(this, args);
  };
}
