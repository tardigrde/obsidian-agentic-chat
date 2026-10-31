/**
 * Minimal TypeSafe System One client for the Obsidian plugin.
 *
 * Jev primer: https://typesafe.ai/blog/introducing-system-one-models-and-jev
 * Harness pattern: https://www.langchain.com/blog/building-a-harness-with-jev
 * (AutoModeMiddleware — classify risky actions BEFORE executing).
 *
 * Notes for this host:
 * - Obsidian renderer fetch can hit CORS/Electron proxy issues, so the
 *   transport is injectable. Production defaults to Obsidian `requestUrl`;
 *   tests inject a mock.
 * - Low-level `queryJev` throws on transport/timeout/malformed responses;
 *   high-level helpers (`rerankMemoryMatches`, scanners) convert every
 *   failure to a heuristic fallback and never throw into the agent loop.
 */

export const JEV_MODEL = "jev-latest";
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_TIMEOUT_MS = 400;

export type JevQuestion =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export interface JevNoulAnswer {
  type: "noul";
  noul: number;
}
export interface JevChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}
export type JevAnswer = JevNoulAnswer | JevChoiceAnswer;

export interface JevTransportRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface JevTransportResponse {
  status: number;
  text: string;
}

export type JevTransport = (
  request: JevTransportRequest,
  signal?: AbortSignal,
) => Promise<JevTransportResponse>;

async function defaultTransport(
  request: JevTransportRequest,
  signal?: AbortSignal,
): Promise<JevTransportResponse> {
  // Lazy import so node/vitest (no Obsidian runtime) can still load this
  // module — tests always inject a mock transport. Cached so the first
  // guarded call doesn't burn scan budget on module load.
  // NOTE: Obsidian `requestUrl` takes no AbortSignal, so `signal` only guards
  // our side via Promise.race — a timed-out request may still complete in the
  // background (bounded: one in flight per scan, no retries).
  const { requestUrl } = await cachedObsidianImport();
  void signal;
  const res = await requestUrl({
    url: request.url,
    method: "POST",
    headers: request.headers,
    body: request.body,
  });
  return { status: res.status, text: res.text };
}

let obsidianImport: Promise<typeof import("obsidian")> | undefined;
function cachedObsidianImport(): Promise<typeof import("obsidian")> {
  if (!obsidianImport) obsidianImport = import("obsidian");
  return obsidianImport;
}

function clampTimeout(raw: number | undefined): number {
  if (!Number.isFinite(raw as number)) return JEV_TIMEOUT_MS;
  return Math.min(Math.max(raw as number, 50), 2000);
}

export async function queryJev(
  state: string,
  questions: Record<string, JevQuestion>,
  opts: {
    apiKey: string;
    timeoutMs?: number;
    endpoint?: string;
    transport?: JevTransport;
  },
): Promise<{ answers: Record<string, JevAnswer> }> {
  if (!opts.apiKey) throw new Error("missing TYPESAFE_API_KEY");
  const endpoint = opts.endpoint ?? JEV_ENDPOINT;
  if (endpoint !== JEV_ENDPOINT) throw new Error("jev endpoint not allowlisted");
  const timeoutMs = clampTimeout(opts.timeoutMs);
  const transport = opts.transport ?? defaultTransport;

  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new Error("jev timeout"));
    }, timeoutMs);
  });
  try {
    const request = transport(
      {
        url: endpoint,
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: JEV_MODEL, state, questions }),
      },
      ctrl.signal,
    );
    // Non-OK responses throw before body parse (error bodies aren't JSON).
    // The chained promise gets its own catch so a timeout-win followed by a
    // late parse throw can't surface as an unhandled rejection.
    const chained = request.then(async (r) => {
      if (r.status < 200 || r.status >= 300)
        return { r, j: null as unknown as { answers: Record<string, JevAnswer> } };
      return { r, j: JSON.parse(r.text) as { answers: Record<string, JevAnswer> } };
    });
    chained.catch(() => {});
    const res = await Promise.race([chained, timeout]);
    if (res.r.status < 200 || res.r.status >= 300) {
      throw new Error(`jev http ${res.r.status}`);
    }
    const answers = (res.j as { answers?: unknown } | null)?.answers;
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
      throw new Error("jev malformed response");
    }
    return { answers: answers as Record<string, JevAnswer> };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
