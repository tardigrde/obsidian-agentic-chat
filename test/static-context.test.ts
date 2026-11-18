import { getCurrentSystemPrompt, getCurrentTools, type Context, type Tool } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { replayTextTurn } from "../src/agent/replay-stream";
import { estimateToolDefinitionTokens } from "../src/agent/tool-schema-tokens";
import { BUILTIN_TOOL_NAMES } from "../src/tools/tool-contracts";
import { runAgentReplay } from "./helpers/agent-replay";

/**
 * The static context check (#393 T20). It was the "static.default-context"
 * case of the agentic eval runner; it needs no model, so it is a unit test.
 * It reads the first request the agent sends with default settings, the same
 * system prompt and tool list a provider gets.
 */

/** Budgets with about 10% headroom over the 2026-11-18 numbers (1,675 tokens, 4,294 chars). */
const MAX_TOOL_SCHEMA_TOKENS = 1850;
const MAX_SYSTEM_PROMPT_CHARS = 4800;

const PROMPT_PHRASES = [
  "Context hygiene",
  "Do not re-read",
  "offset/limit",
  "treat it as a denied action",
  // Pinned again after #396 deleted their old prose tests.
  "ignore-listed",
  "path-only reference",
  "`self-knowledge` skill",
];

async function firstRequest(): Promise<{ systemPrompt: string; tools: Tool[] }> {
  let first: Context | undefined;
  await runAgentReplay({
    prompt: "Build a concise DevOps knowledge base from the vault and keep context/tool use efficient.",
    onRequest: (context) => {
      first ??= context as Context;
    },
    turns: [replayTextTurn("ok")],
  });
  if (!first) throw new Error("the agent sent no request");
  return { systemPrompt: getCurrentSystemPrompt(first.messages), tools: getCurrentTools(first.messages) };
}

function mentions(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}($|[^A-Za-z0-9_-])`, "i").test(text);
}

function tool(tools: Tool[], name: string): Tool {
  const found = tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`${name} is not on the default tool surface`);
  return found;
}

describe("static context of the default request", () => {
  it("keeps the context-hygiene and denied-action phrases in the system prompt", async () => {
    const { systemPrompt } = await firstRequest();
    for (const phrase of PROMPT_PHRASES) expect(systemPrompt, phrase).toContain(phrase);
  });

  it("names no vault tool in the system prompt that the request does not register", async () => {
    const { systemPrompt, tools } = await firstRequest();
    const registered = new Set(tools.map((entry) => entry.name));
    const unavailable = BUILTIN_TOOL_NAMES.filter((name) => !registered.has(name) && mentions(systemPrompt, name));
    expect(unavailable).toEqual([]);
  });

  it("registers every built-in vault tool and the steering words in their descriptions", async () => {
    const { tools } = await firstRequest();
    for (const name of BUILTIN_TOOL_NAMES) tool(tools, name);
    expect(JSON.stringify(tool(tools, "edit").parameters)).toContain("exactly once");
    expect(tool(tools, "write").description).toContain("frontmatter");
  });

  it("keeps the whole tool surface and the system prompt inside their budgets", async () => {
    const { systemPrompt, tools } = await firstRequest();
    expect(estimateToolDefinitionTokens(tools)).toBeLessThanOrEqual(MAX_TOOL_SCHEMA_TOKENS);
    expect(systemPrompt.length).toBeLessThanOrEqual(MAX_SYSTEM_PROMPT_CHARS);
  });
});
