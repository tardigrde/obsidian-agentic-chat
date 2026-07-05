import https from "node:https";
import process from "node:process";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { discoverMcpOAuthMetadata } from "../src/mcp/oauth";
import { createMcpServerSettings } from "../src/mcp/settings";
import { probeMcpServer } from "../src/mcp/tools";
import { redactText } from "../src/privacy/redaction";
import type { WebFetcher, WebHttpRequest, WebHttpResponse } from "../src/tools/web-fetch";

const DEFAULT_REMOTE_MCP_URL = "";
const REQUEST_TIMEOUT_MS = 20_000;
const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  const url = process.env.AGENTIC_CHAT_LIVE_MCP_URL?.trim() || DEFAULT_REMOTE_MCP_URL;
  if (!url.startsWith("https://")) throw new Error("AGENTIC_CHAT_LIVE_MCP_URL must start with https://");

  const server = createMcpServerSettings({
    id: "remote_mcp",
    name: "Remote MCP",
    url,
    authType: "oauth",
  });

  const metadata = await discoverMcpOAuthMetadata(server, nodeHttpsFetch, REQUEST_TIMEOUT_MS);
  writeLine("Remote MCP OAuth metadata OK:");
  writeLine(`  resource metadata: ${metadata.resourceMetadataUrl}`);
  writeLine(`  authorization server: ${metadata.authorizationServer}`);
  writeLine(`  authorization endpoint: ${metadata.authorizationEndpoint}`);
  writeLine(`  token endpoint: ${metadata.tokenEndpoint}`);
  writeLine(`  registration endpoint: ${metadata.registrationEndpoint}`);
  writeLine(`  scopes: ${metadata.scopes.join(", ") || "(none advertised)"}`);
  writeLine(`  PKCE methods: ${metadata.codeChallengeMethods.join(", ") || "(none advertised)"}`);

  const accessToken = process.env.AGENTIC_CHAT_LIVE_MCP_ACCESS_TOKEN?.trim() || "";
  if (!accessToken) {
    writeLine("");
    writeLine("Set AGENTIC_CHAT_LIVE_MCP_ACCESS_TOKEN to also verify authenticated tool discovery.");
    return;
  }

  server.oauth.accessToken = accessToken;
  server.oauth.refreshToken = process.env.AGENTIC_CHAT_LIVE_MCP_REFRESH_TOKEN?.trim() || "";
  server.oauth.clientId = process.env.AGENTIC_CHAT_LIVE_MCP_CLIENT_ID?.trim() || "";
  server.oauth.tokenEndpoint = process.env.AGENTIC_CHAT_LIVE_MCP_TOKEN_ENDPOINT?.trim() || metadata.tokenEndpoint;

  const probe = await probeMcpServer(server, nodeHttpsFetch);
  writeLine("");
  writeLine(`Remote MCP authenticated tool discovery OK: ${probe.toolCount} tools`);
  writeLine(`  sample: ${probe.toolNames.slice(0, 10).join(", ") || "(no tools)"}`);
}

const nodeHttpsFetch: WebFetcher = async (request) => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await nodeHttpsFetchOnce(request);
    } catch (error) {
      lastError = error;
      if (!isTransientNetworkError(error) || attempt === 3) break;
      await delay(500 * attempt);
    }
  }
  if (lastError && isTransientNetworkError(lastError)) {
    process.stderr.write("Node HTTPS hit a transient network error; retrying this request with curl.\n");
    return curlFetch(request);
  }
  throw lastError;
};

const nodeHttpsFetchOnce: WebFetcher = async (request) => {
  return await new Promise<WebHttpResponse>((resolve, reject) => {
    const clientRequest = https.request(
      request.url,
      {
        method: request.method ?? "GET",
        headers: request.headers,
        timeout: REQUEST_TIMEOUT_MS,
      },
      (response) => {
        const chunks: string[] = [];
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => chunks.push(chunk));
        response.on("end", () => {
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) headers[key.toLowerCase()] = value.join(", ");
            else if (value !== undefined) headers[key.toLowerCase()] = String(value);
          }
          resolve({ status: response.statusCode ?? 0, text: chunks.join(""), headers });
        });
      },
    );
    clientRequest.on("timeout", () => clientRequest.destroy(new Error("HTTPS request timed out.")));
    clientRequest.on("error", reject);
    if (request.body) clientRequest.write(request.body);
    clientRequest.end();
  });
};

async function curlFetch(request: WebHttpRequest): Promise<WebHttpResponse> {
  if ((request.method ?? "GET") === "GET" && request.body === undefined) {
    return { status: 200, text: await runSimpleCurlGet(request.url), headers: {} };
  }

  const dir = await mkdtemp(join(tmpdir(), "agentic-chat-remote-mcp-"));
  const headersPath = join(dir, "headers.txt");
  const bodyPath = join(dir, "body.txt");
  try {
    const args = [
      "-sS",
      "--max-time",
      String(Math.ceil(REQUEST_TIMEOUT_MS / 1000)),
      "--dump-header",
      headersPath,
      "--output",
      bodyPath,
      "-X",
      request.method ?? "GET",
    ];
    for (const [key, value] of Object.entries(request.headers ?? {})) {
      args.push("-H", `${key}: ${value}`);
    }
    if (request.body !== undefined) args.push("--data-binary", request.body);
    args.push(request.url);

    await runCurl(args);
    const headersText = await readFile(headersPath, "utf8");
    const text = await readFile(bodyPath, "utf8");
    return { status: parseCurlStatus(headersText), text, headers: parseCurlHeaders(headersText) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runSimpleCurlGet(url: string): Promise<string> {
  const candidates = process.env.AGENTIC_CHAT_LIVE_MCP_CURL_BIN?.trim()
    ? [[process.env.AGENTIC_CHAT_LIVE_MCP_CURL_BIN.trim(), "-fsSL"]]
    : [["curl", "-fsSL"], ["rtk", "curl", "-fsSL"]];
  const errors: string[] = [];
  for (const [command, ...prefixArgs] of candidates) {
    try {
      const { stdout } = await execFileAsync(command, [...prefixArgs, url], {
        timeout: REQUEST_TIMEOUT_MS + 5_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      errors.push(`${[command, ...prefixArgs].join(" ")}: ${curlErrorMessage(error)}`);
    }
  }
  throw new Error(`curl GET fallback failed: ${errors.join("; ")}`);
}

async function runCurl(args: string[]): Promise<void> {
  const candidates = process.env.AGENTIC_CHAT_LIVE_MCP_CURL_BIN?.trim()
    ? [[process.env.AGENTIC_CHAT_LIVE_MCP_CURL_BIN.trim()]]
    : [["curl"], ["rtk", "curl"]];
  const errors: string[] = [];
  for (const [command, ...prefixArgs] of candidates) {
    try {
      await execFileAsync(command, [...prefixArgs, ...args], { timeout: REQUEST_TIMEOUT_MS + 5_000 });
      return;
    } catch (error) {
      errors.push(`${[command, ...prefixArgs].join(" ")}: ${curlErrorMessage(error)}`);
    }
  }
  throw new Error(`curl fallback failed: ${errors.join("; ")}`);
}

function curlErrorMessage(error: unknown): string {
  const record = error && typeof error === "object" ? (error as { code?: unknown; stderr?: unknown }) : {};
  const stderr = typeof record.stderr === "string" ? record.stderr.trim() : "";
  if (stderr) return redactSecrets(stderr);
  return `exit ${String(record.code ?? "unknown")}`;
}

function redactSecrets(value: string): string {
  return redactText(value, { redactHighEntropy: true });
}

function parseCurlStatus(headersText: string): number {
  const block = lastCurlHeaderBlock(headersText);
  const status = /^HTTP\/\S+\s+(\d+)/i.exec(block)?.[1];
  return status ? Number.parseInt(status, 10) : 0;
}

function parseCurlHeaders(headersText: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of lastCurlHeaderBlock(headersText).split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return headers;
}

function lastCurlHeaderBlock(headersText: string): string {
  const blocks = headersText
    .trim()
    .split(/\r?\n\r?\n/)
    .filter((block) => /^HTTP\//i.test(block));
  return blocks.at(-1) ?? "";
}

function isTransientNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message} ${(error as { code?: string }).code ?? ""}` : String(error);
  return /EAI_AGAIN|ENOTFOUND|ETIMEDOUT|ECONNRESET|timed out|Could not resolve host/i.test(message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeLine(message: string): void {
  process.stdout.write(`${message}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`Remote MCP check failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
