/**
 * Smoke test for the pi packages this plugin is migrating to. Proves the
 * pinned versions load in our toolchain and that the Agent loop, tool
 * execution, and the faux provider behave as the migration plan assumes.
 */
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  type FauxProviderRegistration,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  registerFauxProvider,
} from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";

const readNoteSchema = Type.Object({
  path: Type.String({ description: "Vault-relative path" }),
});

const fakeVault = new Map<string, string>([["Inbox/Todo.md", "- [ ] water the plants"]]);

const readNoteTool: AgentTool<typeof readNoteSchema, undefined> = {
  label: "Read note",
  name: "read_note",
  description: "Read a note from the vault",
  parameters: readNoteSchema,
  execute: async (_toolCallId: string, args: Static<typeof readNoteSchema>) => {
    const content = fakeVault.get(args.path);
    if (content === undefined) throw new Error(`No note at "${args.path}"`);
    return { content: [{ type: "text" as const, text: content }], details: undefined };
  },
};

const registrations: FauxProviderRegistration[] = [];

function fauxProvider(): FauxProviderRegistration {
  const registration = registerFauxProvider();
  registrations.push(registration);
  return registration;
}

afterEach(() => {
  while (registrations.length > 0) registrations.pop()?.unregister();
});

function textOf(message: { content: Array<{ type: string }> }): string {
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

describe("pi smoke", () => {
  it("streams a plain text response through the Agent", async () => {
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage("Hello from pi.")]);

    const agent = new Agent({
      initialState: {
        systemPrompt: "You are a vault assistant.",
        model: faux.getModel(),
        thinkingLevel: "off",
        tools: [],
      },
    });
    await agent.prompt("Say hello.");

    expect(agent.state.isStreaming).toBe(false);
    expect(agent.state.errorMessage).toBeUndefined();
    const last = agent.state.messages.at(-1);
    if (last?.role !== "assistant") throw new Error("Expected assistant message");
    expect(textOf(last)).toBe("Hello from pi.");
  });

  it("runs a tool-call roundtrip with a TypeBox-schema tool", async () => {
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxText("Reading the note."),
          fauxToolCall("read_note", { path: "Inbox/Todo.md" }, { id: "call-1" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Your todo: water the plants."),
    ]);

    const agent = new Agent({
      initialState: {
        systemPrompt: "You are a vault assistant.",
        model: faux.getModel(),
        thinkingLevel: "off",
        tools: [readNoteTool],
      },
    });
    await agent.prompt("What is on my todo list?");

    const toolResult = agent.state.messages.find((message) => message.role === "toolResult");
    expect(toolResult).toBeDefined();
    if (toolResult?.role !== "toolResult") throw new Error("Expected tool result message");
    expect(textOf(toolResult)).toContain("water the plants");

    const last = agent.state.messages.at(-1);
    if (last?.role !== "assistant") throw new Error("Expected final assistant message");
    expect(textOf(last)).toContain("water the plants");
    expect(agent.state.pendingToolCalls.size).toBe(0);
  });

  it("surfaces tool errors to the model instead of crashing the run", async () => {
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("read_note", { path: "Missing.md" }, { id: "call-2" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("That note does not exist."),
    ]);

    const agent = new Agent({
      initialState: {
        systemPrompt: "You are a vault assistant.",
        model: faux.getModel(),
        thinkingLevel: "off",
        tools: [readNoteTool],
      },
    });
    await agent.prompt("Read Missing.md");

    const toolResult = agent.state.messages.find((message) => message.role === "toolResult");
    if (toolResult?.role !== "toolResult") throw new Error("Expected tool result message");
    expect(toolResult.isError).toBe(true);
    expect(textOf(toolResult)).toContain("Missing.md");
    expect(agent.state.isStreaming).toBe(false);
  });
});
