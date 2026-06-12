import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { Agent } from "../src/agent/agent";
import { AgentRunError, ModelRetry, UsageLimitExceeded } from "../src/agent/errors";
import { defineTool, RunContext } from "../src/agent/tool";
import type { AgentEvent } from "../src/agent/types";
import { FakeModel, textResponse, toolCallResponse, usageOf } from "./helpers/fake-model";

interface Deps {
  user: string;
  notes: Map<string, string>;
}

function makeDeps(): Deps {
  return { user: "Lev", notes: new Map([["a.md", "alpha content"]]) };
}

const readNote = defineTool({
  name: "read_note",
  description: "Read a note",
  parameters: Type.Object({ path: Type.String() }),
  execute: ({ path }, { deps }: RunContext<Deps>) => {
    const content = deps.notes.get(path);
    if (content === undefined) throw new ModelRetry(`No note at ${path}`);
    return content;
  },
});

describe("Agent.run", () => {
  it("returns plain text output without tools", async () => {
    const model = new FakeModel([textResponse("Hello!")]);
    const agent = new Agent<Deps>({ model, systemPrompt: "You help." });
    const result = await agent.run("hi", { deps: makeDeps() });

    expect(result.output).toBe("Hello!");
    expect(result.steps).toBe(1);
    expect(model.requests[0].messages[0]).toEqual({ role: "system", content: "You help." });
    expect(model.requests[0].messages[1]).toEqual({ role: "user", content: "hi" });
    expect(model.requests[0].tools).toBeUndefined();
  });

  it("executes a tool call and feeds the result back to the model", async () => {
    const model = new FakeModel([
      toolCallResponse("read_note", { path: "a.md" }, "call_42"),
      textResponse("The note says: alpha content"),
    ]);
    const agent = new Agent<Deps>({
      model,
      systemPrompt: "You help.",
      tools: [readNote],
    });

    const result = await agent.run("what is in a.md?", { deps: makeDeps() });

    expect(result.output).toBe("The note says: alpha content");
    expect(result.steps).toBe(2);
    const secondRequest = model.requests[1];
    const toolMessage = secondRequest.messages.find((m) => m.role === "tool");
    expect(toolMessage).toMatchObject({
      role: "tool",
      content: "alpha content",
      tool_call_id: "call_42",
      name: "read_note",
    });
    expect(model.requests[0].tools?.[0].function.name).toBe("read_note");
  });

  it("emits the full event timeline in order", async () => {
    const model = new FakeModel([
      toolCallResponse("read_note", { path: "a.md" }),
      { ...textResponse("done"), deltas: [{ text: "do" }, { text: "ne" }] },
    ]);
    const agent = new Agent<Deps>({ model, systemPrompt: "x", tools: [readNote] });
    const events: AgentEvent[] = [];

    await agent.run("go", { deps: makeDeps(), onEvent: (e) => events.push(e) });

    expect(events.map((e) => e.type)).toEqual([
      "run_start",
      "step_start",
      "tool_call_start",
      "tool_call_end",
      "step_start",
      "text_delta",
      "text_delta",
      "run_end",
    ]);
    const end = events.find((e) => e.type === "run_end");
    expect(end).toMatchObject({ output: "done" });
  });

  it("forwards reasoning deltas as events", async () => {
    const model = new FakeModel([
      { ...textResponse("answer"), deltas: [{ reasoning: "thinking…" }, { text: "answer" }] },
    ]);
    const agent = new Agent<Deps>({ model, systemPrompt: "x" });
    const events: AgentEvent[] = [];

    await agent.run("go", { deps: makeDeps(), onEvent: (e) => events.push(e) });

    expect(events.some((e) => e.type === "reasoning_delta" && e.delta === "thinking…")).toBe(true);
  });

  it("sends a validation error back to the model and recovers", async () => {
    const model = new FakeModel([
      toolCallResponse("read_note", { path: 5 }),
      toolCallResponse("read_note", { path: "a.md" }),
      textResponse("recovered"),
    ]);
    const agent = new Agent<Deps>({ model, systemPrompt: "x", tools: [readNote] });

    const result = await agent.run("go", { deps: makeDeps() });

    expect(result.output).toBe("recovered");
    const retryMessage = model.requests[1].messages.find((m) => m.role === "tool");
    expect(retryMessage?.content).toContain("Invalid arguments");
    expect(retryMessage?.content).toContain("path");
    expect(model.requests).toHaveLength(3);
  });

  it("handles ModelRetry from a tool and recovers", async () => {
    const model = new FakeModel([
      toolCallResponse("read_note", { path: "missing.md" }),
      toolCallResponse("read_note", { path: "a.md" }),
      textResponse("found it"),
    ]);
    const agent = new Agent<Deps>({ model, systemPrompt: "x", tools: [readNote] });

    const result = await agent.run("go", { deps: makeDeps() });

    expect(result.output).toBe("found it");
    const retryMessage = model.requests[1].messages.find((m) => m.role === "tool");
    expect(retryMessage?.content).toContain("No note at missing.md");
  });

  it("fails the run when a tool exhausts its retry budget", async () => {
    const model = new FakeModel([
      toolCallResponse("read_note", { path: "missing.md" }),
      toolCallResponse("read_note", { path: "still-missing.md" }),
    ]);
    const agent = new Agent<Deps>({ model, systemPrompt: "x", tools: [readNote] });

    await expect(agent.run("go", { deps: makeDeps() })).rejects.toThrow(AgentRunError);
    await expect(
      new Agent<Deps>({
        model: new FakeModel([
          toolCallResponse("read_note", { path: "m1.md" }),
          toolCallResponse("read_note", { path: "m2.md" }),
        ]),
        systemPrompt: "x",
        tools: [readNote],
      }).run("go", { deps: makeDeps() }),
    ).rejects.toThrow(/failed after 2 attempts/);
  });

  it("resets a tool's retry budget after a successful call", async () => {
    // fail → recover (success resets the tally) → fail → recover again.
    // Without the reset the second failure would exhaust the budget and abort.
    const model = new FakeModel([
      toolCallResponse("read_note", { path: "missing.md" }, "c1"),
      toolCallResponse("read_note", { path: "a.md" }, "c2"),
      toolCallResponse("read_note", { path: "missing-again.md" }, "c3"),
      toolCallResponse("read_note", { path: "a.md" }, "c4"),
      textResponse("done"),
    ]);
    const agent = new Agent<Deps>({ model, systemPrompt: "x", tools: [readNote] });

    const result = await agent.run("go", { deps: makeDeps() });

    expect(result.output).toBe("done");
    expect(model.requests).toHaveLength(5);
  });

  it("reports unknown tools to the model without crashing", async () => {
    const model = new FakeModel([
      toolCallResponse("bogus_tool", { x: 1 }),
      textResponse("ok then"),
    ]);
    const agent = new Agent<Deps>({ model, systemPrompt: "x", tools: [readNote] });

    const result = await agent.run("go", { deps: makeDeps() });

    expect(result.output).toBe("ok then");
    const toolMessage = model.requests[1].messages.find((m) => m.role === "tool");
    expect(toolMessage?.content).toContain('Unknown tool: "bogus_tool"');
    expect(toolMessage?.content).toContain("read_note");
  });

  it("surfaces unexpected tool errors to the model instead of crashing", async () => {
    const exploding = defineTool({
      name: "explode",
      description: "always throws",
      parameters: Type.Object({}),
      execute: (): string => {
        throw new Error("boom");
      },
    });
    const model = new FakeModel([toolCallResponse("explode", {}), textResponse("survived")]);
    const agent = new Agent<Deps>({ model, systemPrompt: "x", tools: [exploding] });

    const result = await agent.run("go", { deps: makeDeps() });

    expect(result.output).toBe("survived");
    const toolMessage = model.requests[1].messages.find((m) => m.role === "tool");
    expect(toolMessage?.content).toContain("Tool execution failed: boom");
  });

  it("throws UsageLimitExceeded when maxSteps is reached", async () => {
    const model = new FakeModel([
      toolCallResponse("read_note", { path: "a.md" }, "c1"),
      toolCallResponse("read_note", { path: "a.md" }, "c2"),
    ]);
    const agent = new Agent<Deps>({ model, systemPrompt: "x", tools: [readNote], maxSteps: 2 });

    await expect(agent.run("go", { deps: makeDeps() })).rejects.toThrow(UsageLimitExceeded);
  });

  it("accumulates usage across steps", async () => {
    const model = new FakeModel([
      toolCallResponse("read_note", { path: "a.md" }, "c1", usageOf(10, 5)),
      textResponse("done", usageOf(20, 7)),
    ]);
    const agent = new Agent<Deps>({ model, systemPrompt: "x", tools: [readNote] });

    const result = await agent.run("go", { deps: makeDeps() });

    expect(result.usage).toEqual({
      promptTokens: 30,
      completionTokens: 12,
      totalTokens: 42,
      requests: 2,
    });
  });

  it("includes prior history in the request and the result transcript", async () => {
    const model = new FakeModel([textResponse("again?")]);
    const agent = new Agent<Deps>({ model, systemPrompt: "sys" });
    const history = [
      { role: "user" as const, content: "earlier question" },
      { role: "assistant" as const, content: "earlier answer" },
    ];

    const result = await agent.run("new question", { deps: makeDeps(), history });

    expect(model.requests[0].messages.map((m) => m.content)).toEqual([
      "sys",
      "earlier question",
      "earlier answer",
      "new question",
    ]);
    expect(result.messages).toHaveLength(4); // history + user + assistant
  });

  it("supports dynamic system prompts derived from deps", async () => {
    const model = new FakeModel([textResponse("hi")]);
    const agent = new Agent<Deps>({
      model,
      systemPrompt: (deps) => `You help ${deps.user}.`,
    });

    await agent.run("hello", { deps: makeDeps() });

    expect(model.requests[0].messages[0].content).toBe("You help Lev.");
  });

  it("aborts before issuing a request when the signal is already aborted", async () => {
    const model = new FakeModel([textResponse("never")]);
    const agent = new Agent<Deps>({ model, systemPrompt: "x" });
    const controller = new AbortController();
    controller.abort();
    const events: AgentEvent[] = [];

    await expect(
      agent.run("go", { deps: makeDeps(), signal: controller.signal, onEvent: (e) => events.push(e) }),
    ).rejects.toThrow(/aborted/i);
    expect(model.requests).toHaveLength(0);
    expect(events.at(-1)?.type).toBe("run_error");
  });

  it("rejects duplicate tool names at construction", () => {
    expect(
      () =>
        new Agent<Deps>({
          model: new FakeModel([]),
          systemPrompt: "x",
          tools: [readNote, readNote],
        }),
    ).toThrow(/Duplicate tool name/);
  });

  it("executes multiple tool calls from a single response in order", async () => {
    const model = new FakeModel([
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "c1", type: "function", function: { name: "read_note", arguments: '{"path":"a.md"}' } },
            { id: "c2", type: "function", function: { name: "read_note", arguments: '{"path":"a.md"}' } },
          ],
        },
        usage: usageOf(0, 0),
        finishReason: "tool_calls",
      },
      textResponse("both done"),
    ]);
    const agent = new Agent<Deps>({ model, systemPrompt: "x", tools: [readNote] });

    const result = await agent.run("go", { deps: makeDeps() });

    expect(result.output).toBe("both done");
    const toolMessages = model.requests[1].messages.filter((m) => m.role === "tool");
    expect(toolMessages.map((m) => m.tool_call_id)).toEqual(["c1", "c2"]);
  });
});
