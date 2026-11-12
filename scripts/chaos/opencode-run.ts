/**
 * Run one model call through the local `opencode run` CLI.
 *
 * The chaos explorer and miner use this backend when the run passes
 * `--llm opencode`. It spends the user's flat-rate subscription, not API
 * credits. The plugin under test cannot use it, so it keeps an
 * OpenAI-compatible endpoint.
 *
 * Types come from ./explorer-llm with `import type` only: explorer-llm imports
 * this module, and a value import both ways would make a cycle.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatMessage, ChatReply, ChatRequest } from "./explorer-llm";

/** cwd for the child. Only this directory's agent file is visible to opencode. */
export const OPENCODE_AGENT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "opencode-agent");

const DEFAULT_TIMEOUT_MS = 300_000;
const RETRY_BASE_MS = 1_500;
const STDERR_TAIL = 300;

type OpencodePart = {
  type?: string;
  text?: string;
  reason?: string;
  cost?: unknown;
  tokens?: { input?: unknown; output?: unknown; reasoning?: unknown; cache?: { read?: unknown } };
  error?: unknown;
};

type OpencodeLine = {
  type?: string;
  part?: OpencodePart;
  error?: unknown;
  message?: unknown;
};

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function errorDetail(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  const record = value as { message?: unknown; data?: { message?: unknown } };
  if (typeof record.message === "string") return record.message;
  if (typeof record.data?.message === "string") return record.data.message;
  return undefined;
}

/** Build one plain prompt. System text first, then the turns in order. */
export function serializeMessages(messages: ChatMessage[], json: boolean): string {
  const sections: string[] = [];
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content.trim())
    .filter(Boolean);
  if (system.length > 0) sections.push(`# Instructions\n\n${system.join("\n\n")}`);
  for (const message of messages) {
    if (message.role === "system") continue;
    sections.push(`## ${message.role}\n\n${message.content}`);
  }
  if (json) sections.push("Reply with one JSON object only. No prose, no code fence.");
  return `${sections.join("\n\n")}\n`;
}

/** Read the JSON lines that `opencode run --format json` writes to stdout. */
export function parseOpencodeOutput(stdout: string, fallbackModel: string): ChatReply {
  const texts: string[] = [];
  let promptTokens = 0;
  let completionTokens = 0;
  let cost = 0;
  let finishReason: string | undefined;

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: OpencodeLine;
    try {
      event = JSON.parse(trimmed) as OpencodeLine;
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") continue;
    if (event.type === "error") {
      const detail = errorDetail(event.part?.error) ?? errorDetail(event.error) ?? errorDetail(event.message);
      throw new Error(`opencode error: ${detail ?? "unknown error"}`);
    }
    if (event.type === "text" && typeof event.part?.text === "string") texts.push(event.part.text);
    if (event.type === "step_finish") {
      const tokens = event.part?.tokens;
      promptTokens += toNumber(tokens?.input) + toNumber(tokens?.cache?.read);
      completionTokens += toNumber(tokens?.output) + toNumber(tokens?.reasoning);
      const stepCost = event.part?.cost;
      if (typeof stepCost === "number" && Number.isFinite(stepCost)) cost += stepCost;
      if (typeof event.part?.reason === "string") finishReason = event.part.reason;
    }
  }

  if (texts.length === 0) throw new Error("opencode returned no text");
  return {
    text: texts.join(""),
    model: fallbackModel,
    ...(finishReason ? { finishReason } : {}),
    usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, cost },
  };
}

/** opencode wants `provider/model`. A bare model name gets the Go provider. */
function qualifiedModel(model: string): string {
  const trimmed = model.trim();
  return trimmed.includes("/") ? trimmed : `opencode-go/${trimmed}`;
}

function stderrTail(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed.length > STDERR_TAIL ? trimmed.slice(-STDERR_TAIL) : trimmed;
}

function runOnce(model: string, input: string, timeoutMs: number): Promise<ChatReply> {
  return new Promise<ChatReply>((resolve, reject) => {
    const bin = process.env.OPENCODE_BIN || "opencode";
    const args = ["run", "--archived", "--agent", "chaos-llm", "-m", model, "--format", "json"];
    // maxTokens and temperature are ignored on purpose: `opencode run` has no
    // flag for them. The prompt controls the reply shape.
    const child = spawn(bin, args, { cwd: OPENCODE_AGENT_DIR, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`opencode timed out after ${timeoutMs} ms`));
        return;
      }
      const tail = stderrTail(stderr);
      try {
        const reply = parseOpencodeOutput(stdout, model);
        if (code !== 0) {
          reject(new Error(`opencode exited with code ${code}${tail ? `: ${tail}` : ""}`));
          return;
        }
        resolve(reply);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reject(
          new Error(
            code === 0
              ? message
              : `opencode exited with code ${code}: ${message}${tail ? `; stderr: ${tail}` : ""}`,
          ),
        );
      }
    });
    child.stdin?.end(input);
  });
}

export async function opencodeComplete(request: ChatRequest, attempts = 2): Promise<ChatReply> {
  const model = qualifiedModel(request.model);
  const input = serializeMessages(request.messages, request.json === true);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await runOnce(model, input, request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    } catch (error) {
      lastError = error;
    }
    if (attempt === attempts) break;
    await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_MS * attempt));
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  // Never put env values in this error. It can hold stdin text and stderr only.
  throw new Error(`opencode failed after ${attempts} attempt(s): ${detail}`);
}
