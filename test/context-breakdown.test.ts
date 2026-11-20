import { describe, expect, it } from "vitest";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { App } from "obsidian";
import { CachedContextOverheadCounter, contextReadout, estimateContextLoad } from "../src/agent/readouts";
import { AgentRuntimeResourceState } from "../src/agent/runtime-resource-state";
import { isDeferredToolName } from "../src/agent/tool-loading";
import { DEFAULT_SETTINGS } from "../src/settings-schema";
import type { ToolArtifactStoreLike } from "../src/artifacts/tool-artifact-store";
import { formatContextBreakdown } from "../src/ui/context-bar";
import { ReadMemo } from "../src/vault/read-memo";
import { FakeApp } from "./helpers/fake-vault";

const tool = (name: string): AgentTool =>
  ({ name, label: name, description: `${name} does one thing`, parameters: { type: "object", properties: {} } }) as unknown as AgentTool;

const user = (text: string): AgentMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 }) as AgentMessage;
const toolResult = (text: string): AgentMessage =>
  ({ role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: 2 }) as unknown as AgentMessage;

const tools = [tool("read"), tool("write"), tool("mcp__notion__search"), tool("mcp__github__issues")];
const instructions = "Prefer short notes. ".repeat(40);
const skills = "## Skills\n- summarize: summarize a note\n".repeat(10);
const systemPrompt = `You are a vault agent.\n\n${instructions}\n\n${skills}`;
const messages = [user("plan the week"), toolResult("Meeting notes. ".repeat(200))];

describe("context breakdown", () => {
  it("splits the system prompt, tools, and conversation; deferred tools count as 0 tokens", () => {
    const parts = { instructions, skills, deferredNotLoaded: 14 };
    const load = estimateContextLoad({ messages, systemPrompt, tools, reserveTokens: 3000, parts });
    const withoutDeferred = estimateContextLoad({ messages, systemPrompt, tools, reserveTokens: 3000, parts: { instructions, skills } });
    expect(load.breakdown).toBeDefined();
    const b = load.breakdown!;

    expect(b.instructionsTokens).toBe(estimateTextTokens(instructions));
    expect(b.skillsTokens).toBe(estimateTextTokens(skills));
    expect(b.instructionsTokens + b.skillsTokens).toBeLessThanOrEqual(load.systemPromptTokens);
    // MCP is measured on its own (not derived from the total): it equals the
    // estimate of the MCP schemas alone.
    const mcpOnly = estimateContextLoad({ messages: [], systemPrompt: "", tools: tools.filter((t) => t.name.startsWith("mcp__")) });
    expect(b.mcpToolTokens).toBe(mcpOnly.toolSchemaTokens);
    expect(b.builtinToolTokens).toBe(load.toolSchemaTokens - mcpOnly.toolSchemaTokens);
    expect(b.mcpToolTokens).toBeGreaterThan(0);
    expect(b.mcpServers).toBe(2);
    expect(b.toolResultTokens).toBeGreaterThan(0);
    expect(b.toolResultTokens).toBeLessThan(load.transcriptTokens);
    // Deferred tools are not sent: a count, and no tokens in any total.
    expect(b.deferredNotLoaded).toBe(14);
    expect(load.totalTokens).toBe(withoutDeferred.totalTokens);
    expect(load.toolSchemaTokens).toBe(withoutDeferred.toolSchemaTokens);
  });

  it("gives the same numbers through the cached counter", () => {
    const counter = new CachedContextOverheadCounter();
    const parts = { instructions, skills, deferredNotLoaded: 3 };
    const plain = estimateContextLoad({ messages, systemPrompt, tools, parts });
    const cached = estimateContextLoad({ messages, systemPrompt, tools, parts }, counter);
    expect(cached.breakdown).toEqual(plain.breakdown);
    expect(estimateContextLoad({ messages, systemPrompt, tools, parts }, counter).breakdown).toEqual(plain.breakdown);
  });

  it("formats the tooltip: estimated total, sections with shares, deferred as a count", () => {
    const readout = contextReadout({
      messages,
      systemPrompt,
      tools,
      reserveTokens: 3000,
      contextWindow: 128_000,
      parts: { instructions, skills, deferredNotLoaded: 14 },
    });
    expect(typeof formatContextBreakdown).toBe("function");
    const text = formatContextBreakdown(readout!, 46_900);
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/^\d+% · [\d.]+k \/ 128k tokens \(estimated\)$/);
    expect(text).toMatch(/^System prompt\s+[\d.]+k?\s+\d+%$/m);
    // Instructions can come from AGENTS.md, CLAUDE.md, or GEMINI.md: no file name.
    expect(text).toMatch(/^ {2}Instructions\s+[\d.]+k?$/m);
    expect(text).toMatch(/^ {2}Skills loaded\s+[\d.]+k?$/m);
    expect(text).toMatch(/^Tools\s+[\d.]+k?\s+\d+%$/m);
    expect(text).toMatch(/^ {2}MCP\s+[\d.]+k?\s+\(2 servers\)$/m);
    expect(text).toMatch(/^ {2}MCP deferred\s+14 tools, not loaded$/m);
    expect(text).toMatch(/^Conversation\s+[\d.]+k?\s+\d+%$/m);
    expect(text).toMatch(/^ {2}Tool results\s+[\d.]+k?$/m);
    expect(text).toMatch(/^Kept for answer\s+3k$/m);
    expect(lines.at(-1)).toBe("Last reply: 46.9k tokens sent (provider count)");
  });

  it("without parts it shows only the four sections", () => {
    const readout = contextReadout({ messages, systemPrompt, tools, reserveTokens: 0, contextWindow: 10_000 });
    const text = formatContextBreakdown(readout!);
    expect(text.split("\n").map((line) => line.trim().split(/\s{2,}/)[0])).toEqual([
      expect.stringMatching(/tokens \(estimated\)$/),
      "System prompt",
      "Tools",
      "Conversation",
      "Kept for answer",
    ]);
  });

  it("contextParts: vault instructions, and only unloaded MCP tools count as deferred", async () => {
    const app = new FakeApp();
    await app.vault.create("AGENTS.md", "Always answer in one paragraph.");
    const state = new AgentRuntimeResourceState({
      app: app as unknown as App,
      getSettings: () => DEFAULT_SETTINGS,
      readMemo: new ReadMemo(),
      webFetch: async () => ({ status: 200, text: "", headers: {} }),
      artifactStore: {} as ToolArtifactStoreLike,
    });
    await state.reload();
    // Two MCP tools, as a connected server would give them.
    const internals = state as unknown as { resources: { mcpTools: AgentTool[] } };
    internals.resources = { ...internals.resources, mcpTools: [tool("mcp__notion__search"), tool("mcp__notion__fetch")] };
    const active = state.buildParentTools(DEFAULT_SETTINGS);
    const allDeferred = (state as unknown as { lastBuild: { all: AgentTool[] } }).lastBuild.all.filter((t) => isDeferredToolName(t.name));
    // The fixture has non-MCP deferred tools too; they must not count.
    expect(allDeferred.some((t) => !t.name.startsWith("mcp__"))).toBe(true);
    const loaded = [...active, tool("mcp__notion__search")];
    const parts = state.contextParts(DEFAULT_SETTINGS, loaded);
    expect(parts.deferredNotLoaded).toBe(1);
    expect(parts.instructions).toContain("Always answer in one paragraph.");
  });
});
