import type { WebFetcher, WebHttpRequest, WebHttpResponse } from "../tools/web-fetch";

export const DEFAULT_MCP_HTTP_TIMEOUT_MS = 30_000;

export async function fetchWithMcpTimeout(
  fetcher: WebFetcher,
  request: WebHttpRequest,
  label: string,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_MCP_HTTP_TIMEOUT_MS,
): Promise<WebHttpResponse> {
  if (signal?.aborted) throw new Error("Aborted.");
  return withMcpTimeout(fetcher(request, signal), label, timeoutMs);
}

export async function withMcpTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = DEFAULT_MCP_HTTP_TIMEOUT_MS,
): Promise<T> {
  let timer: number | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = window.setTimeout(() => {
      reject(new Error(`MCP request timed out after ${timeoutMs} ms while ${label}.`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}
