import { describe, expect, it } from "vitest";
import { parseSessionEntries } from "../src/session/jsonl";
import { replayTextTurn, replayToolCallTurn } from "../src/agent/replay-stream";
import { runAgentReplay } from "./helpers/agent-replay";

describe("AgentService replay harness", () => {
  it("replays a blocked tool loop with persisted tool-result evidence", async () => {
    const result = await runAgentReplay({
      prompt: "Create note.md",
      settings: { mode: "plan" },
      turns: [
        replayToolCallTurn("call-1", "write", { path: "note.md", content: "hi" }, { label: "parent write" }),
        replayTextTurn("Read-only, so I held off.", { label: "parent final" }),
      ],
    });

    expect(result.calls.map((call) => call.label)).toEqual(["parent write", "parent final"]);
    expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);

    const toolResult = result.messages.find((message) => message.role === "toolResult");
    expect(toolResult).toMatchObject({ role: "toolResult", toolCallId: "call-1", toolName: "write", isError: true });
    expect(JSON.stringify(toolResult)).toMatch(/Plan mode is read-only/);

    expect(result.events.map((event) => event.type)).toContain("tool_execution_start");
    expect(result.events.map((event) => event.type)).toContain("tool_execution_end");

    const sessionMessages = parseSessionEntries(result.sessionText)
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.message.role);
    expect(sessionMessages).toEqual(["user", "assistant", "toolResult", "assistant"]);
  });

  it("replays parent and subagent turns in exact stream-call order", async () => {
    const result = await runAgentReplay({
      prompt: "Use a subagent to check my inbox",
      turns: [
        replayToolCallTurn(
          "call-1",
          "subagent",
          { agent: "researcher", task: "summarize the inbox" },
          { label: "parent dispatch" },
        ),
        replayTextTurn("Inbox has 3 open threads.", {
          label: "researcher child",
          usage: { input: 2, output: 3, totalTokens: 5 },
        }),
        replayTextTurn("All done.", { label: "parent final" }),
      ],
    });

    expect(result.calls.map((call) => call.label)).toEqual(["parent dispatch", "researcher child", "parent final"]);
    expect(result.calls[0].toolNames).toContain("subagent");
    expect(result.calls[1].systemPrompt).toMatch(/research subagent/i);
    expect(result.calls[2].messageCount).toBeGreaterThan(result.calls[0].messageCount);

    const toolResult = result.messages.find((message) => message.role === "toolResult");
    expect(toolResult).toMatchObject({ role: "toolResult", toolCallId: "call-1", toolName: "subagent", isError: false });
    expect(JSON.stringify(toolResult)).toContain("Inbox has 3 open threads.");
    expect(result.service.getSessionUsage().totalTokens).toBe(5);
  });
});
