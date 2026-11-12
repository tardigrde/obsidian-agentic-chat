import { errorMessage } from "../../utils/errors";
import { optionalNodeRequire } from "./browser-open";
import type { McpOAuthCallback, McpOAuthCallbackReceiver, McpOAuthProtocolParams } from "./types";
import { stringValue } from "./values";

export const DEFAULT_MCP_OAUTH_CALLBACK_PORT = 37123;
export const DEFAULT_MCP_OAUTH_REDIRECT_URI = `http://localhost:${DEFAULT_MCP_OAUTH_CALLBACK_PORT}/oauth/callback`;
export const MCP_OAUTH_OBSIDIAN_PROTOCOL_ACTION = "agentic-chat-mcp-oauth";
export const MCP_OAUTH_OBSIDIAN_REDIRECT_URI = `obsidian://${MCP_OAUTH_OBSIDIAN_PROTOCOL_ACTION}`;

export interface McpOAuthCallbackReceiverOptions {
  allowEphemeralFallback?: boolean;
  http?: NodeHttpModule;
}

export async function createLoopbackOAuthCallbackReceiver(
  options: McpOAuthCallbackReceiverOptions = {},
): Promise<McpOAuthCallbackReceiver> {
  const http = options.http ?? requireNodeHttp();
  let resolveCallback: ((callback: McpOAuthCallback) => void) | null = null;
  const callbackPromise = new Promise<McpOAuthCallback>((resolve) => {
    resolveCallback = resolve;
  });

  const createServer = (): NodeHttpServer => http.createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", "http://localhost");
    const callback: McpOAuthCallback = {
      code: requestUrl.searchParams.get("code") ?? "",
      state: requestUrl.searchParams.get("state") ?? "",
      error: requestUrl.searchParams.get("error") ?? undefined,
      errorDescription: requestUrl.searchParams.get("error_description") ?? undefined,
    };
    response.statusCode = callback.code || callback.error ? 200 : 400;
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(
      "<!doctype html><title>Agentic Chat OAuth</title><body>" +
        (response.statusCode === 200
          ? "Agentic Chat authentication is complete. You can close this window."
          : "Agentic Chat authentication did not return an authorization code.") +
        "</body>",
    );
    resolveCallback?.(callback);
  });

  let server = createServer();
  const address = await listenLoopbackOAuthServer(server, DEFAULT_MCP_OAUTH_CALLBACK_PORT).catch(async (error: unknown) => {
    server.close();
    if (!options.allowEphemeralFallback || !isAddressInUse(error)) throw error;
    server = createServer();
    return await listenLoopbackOAuthServer(server, 0);
  });

  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not start MCP OAuth loopback callback server.");
  }

  return {
    redirectUri: `http://localhost:${address.port}/oauth/callback`,
    waitForCallback: async (expectedState, timeoutMs) => {
      let timeoutId: number | undefined;
      const timeout = new Promise<McpOAuthCallback>((_, reject) => {
        timeoutId = window.setTimeout(() => reject(new Error("Timed out waiting for MCP OAuth callback.")), timeoutMs);
      });
      const callback = await Promise.race([callbackPromise, timeout]).finally(() => {
        if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      });
      if (callback.state !== expectedState) throw new Error("MCP OAuth callback state did not match.");
      return callback;
    },
    close: () => {
      server.close();
    },
  };
}

export class McpOAuthObsidianCallbackBridge {
  private readonly receivers = new Set<ObsidianProtocolOAuthCallbackReceiver>();

  createReceiver(expectedState?: string): McpOAuthCallbackReceiver {
    const receiver = new ObsidianProtocolOAuthCallbackReceiver(() => {
      this.receivers.delete(receiver);
    }, expectedState);
    this.receivers.add(receiver);
    return receiver;
  }

  handleProtocolCallback(params: McpOAuthProtocolParams): boolean {
    const callback = callbackFromProtocolParams(params);
    for (const receiver of this.receivers) {
      if (receiver.receive(callback)) return true;
    }
    return false;
  }
}

type ObsidianProtocolReceiverPhase = "fresh" | "waiting" | "received" | "delivered" | "timed-out" | "closed";

class ObsidianProtocolOAuthCallbackReceiver implements McpOAuthCallbackReceiver {
  readonly redirectUri = MCP_OAUTH_OBSIDIAN_REDIRECT_URI;
  private callback: McpOAuthCallback | null = null;
  private expectedState = "";
  private waiter: ((callback: McpOAuthCallback) => void) | null = null;
  private phase: ObsidianProtocolReceiverPhase = "fresh";

  constructor(
    private readonly onClose: () => void,
    expectedState?: string,
  ) {
    if (expectedState) this.setExpectedState(expectedState);
  }

  setExpectedState(expectedState: string): void {
    if (this.phase === "closed" || this.phase === "delivered") return;
    if (this.expectedState && this.expectedState !== expectedState) {
      throw new Error("MCP OAuth callback receiver is already bound to another state.");
    }
    this.expectedState = expectedState;
    if (this.phase === "fresh") this.phase = "waiting";
  }

  receive(callback: McpOAuthCallback): boolean {
    if (this.phase === "closed" || this.phase === "delivered") return false;
    // A receiver with no expected state must never consume a callback: with
    // concurrent flows it would swallow the other receiver's callback.
    if (!this.expectedState || callback.state !== this.expectedState) return false;
    this.callback = callback;
    if (this.waiter) {
      this.deliver(callback);
    } else {
      this.phase = "received";
    }
    return true;
  }

  async waitForCallback(expectedState: string, timeoutMs: number): Promise<McpOAuthCallback> {
    this.setExpectedState(expectedState);
    let timeoutId: number | undefined;
    const callback = await new Promise<McpOAuthCallback>((resolve, reject) => {
      this.waiter = (value) => {
        if (timeoutId !== undefined) window.clearTimeout(timeoutId);
        resolve(value);
      };
      this.phase = this.callback ? "received" : "waiting";
      timeoutId = window.setTimeout(() => {
        this.waiter = null;
        this.phase = "timed-out";
        reject(
          new Error(
            "Timed out waiting for MCP OAuth callback. If the browser did not return to Obsidian, " +
              "register the Obsidian redirect URI with the provider or authenticate this server on desktop.",
          ),
        );
      }, timeoutMs);
      if (this.callback) this.deliver(this.callback);
    });
    if (callback.state !== expectedState) throw new Error("MCP OAuth callback state did not match.");
    return callback;
  }

  close(): void {
    this.phase = "closed";
    this.expectedState = "";
    this.waiter = null;
    this.onClose();
  }

  private deliver(callback: McpOAuthCallback): void {
    const waiter = this.waiter;
    this.waiter = null;
    this.phase = "delivered";
    waiter?.(callback);
  }
}

function callbackFromProtocolParams(params: McpOAuthProtocolParams): McpOAuthCallback {
  return {
    code: stringValue(params.code),
    state: stringValue(params.state),
    error: stringValue(params.error) || undefined,
    errorDescription: stringValue(params.error_description) || stringValue(params.errorDescription) || undefined,
  };
}

async function listenLoopbackOAuthServer(
  server: NodeHttpServer,
  port: number,
): Promise<{ port: number } | string | null> {
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "localhost", resolve);
  });
  return server.address();
}

function isAddressInUse(error: unknown): boolean {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  const message = errorMessage(error);
  return code === "EADDRINUSE" || /EADDRINUSE|address already in use/i.test(message);
}

function requireNodeHttp(): NodeHttpModule {
  const requireFn = optionalNodeRequire();
  if (!requireFn) {
    throw new Error("MCP OAuth sign-in requires Obsidian desktop so Agentic Chat can open a localhost callback.");
  }
  let http: Partial<NodeHttpModule>;
  try {
    http = requireFn("http") as Partial<NodeHttpModule>;
  } catch {
    throw new Error("MCP OAuth sign-in requires Obsidian desktop so Agentic Chat can open a localhost callback.");
  }
  if (typeof http.createServer !== "function") {
    throw new TypeError("Could not load Node HTTP support for MCP OAuth callback handling.");
  }
  return http as NodeHttpModule;
}

export interface NodeHttpModule {
  createServer(handler: (request: NodeIncomingMessage, response: NodeServerResponse) => void): NodeHttpServer;
}

interface NodeIncomingMessage {
  url?: string;
}

interface NodeServerResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}

interface NodeHttpServer {
  listen(port: number, hostname: string, callback: () => void): void;
  close(callback?: () => void): void;
  address(): { port: number } | string | null;
  on(event: "error", callback: (error: Error) => void): void;
}
