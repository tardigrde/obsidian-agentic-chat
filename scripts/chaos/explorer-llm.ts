/**
 * Minimal OpenAI-compatible chat client for the chaos explorer and miner.
 *
 * It runs in Node (the WDIO worker or the runner), never in Obsidian. It asks
 * OpenRouter for real usage and cost, retries transient failures, and never
 * logs the key.
 */

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type ChatUsage = { promptTokens: number; completionTokens: number; totalTokens: number; cost: number };

export type ChatReply = { text: string; usage: ChatUsage; model: string };

export type ChatRequest = {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  json?: boolean;
};

const RETRY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function parseChatResponse(body: unknown, fallbackModel: string): ChatReply {
  const record = (body ?? {}) as {
    model?: string;
    choices?: Array<{ message?: { content?: unknown; reasoning?: unknown } }>;
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown; cost?: unknown };
    error?: { message?: string };
  };
  if (record.error?.message) throw new Error(`model error: ${record.error.message}`);
  const content = record.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map(String).join("") : "";
  const promptTokens = toNumber(record.usage?.prompt_tokens);
  const completionTokens = toNumber(record.usage?.completion_tokens);
  return {
    text,
    model: record.model ?? fallbackModel,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: toNumber(record.usage?.total_tokens) || promptTokens + completionTokens,
      cost: toNumber(record.usage?.cost),
    },
  };
}

export async function chatComplete(request: ChatRequest, attempts = 3): Promise<ChatReply> {
  const url = `${request.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const payload: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
    max_tokens: request.maxTokens ?? 1_200,
    temperature: request.temperature ?? 0.7,
    usage: { include: true },
  };
  if (request.json) payload.response_format = { type: "json_object" };

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${request.apiKey}` },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(request.timeoutMs ?? 120_000),
      });
      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 300);
        const error = new Error(`HTTP ${response.status}: ${detail}`);
        // A 401, 402, or 404 does not heal on retry; fail at once.
        if (!RETRY_STATUS.has(response.status)) throw Object.assign(error, { fatal: true });
        lastError = error;
      } else {
        return parseChatResponse(await response.json(), request.model);
      }
    } catch (error) {
      if ((error as { fatal?: boolean }).fatal) throw error;
      lastError = error;
    }
    if (attempt === attempts) break;
    await new Promise((resolve) => setTimeout(resolve, 1_500 * attempt));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
