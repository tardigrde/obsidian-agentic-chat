import { describe, expect, it } from "vitest";
import { parseSessionEntries } from "../src/session/jsonl";
import { replayTextTurn, replayToolCallTurn } from "../src/agent/replay-stream";
import { runAgentReplay } from "./helpers/agent-replay";

describe("AgentService replay harness", () => {
  it("replays a blocked tool loop with persisted tool-result evidence", async () => {
    const result = await runAgentReplay({
      prompt: "Create note.md",
      settings: { mode: "safe", approval: { mutating: "allow", perTool: { write: "deny" } } },
      turns: [
        replayToolCallTurn("call-1", "write", { path: "note.md", content: "hi" }, { label: "parent write" }),
        replayTextTurn("Write is disabled, so I held off.", { label: "parent final" }),
      ],
    });

    expect(result.calls.map((call) => call.label)).toEqual(["parent write", "parent final"]);
    expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);

    const toolResult = result.messages.find((message) => message.role === "toolResult");
    expect(toolResult).toMatchObject({ role: "toolResult", toolCallId: "call-1", toolName: "write", isError: true });
    expect(JSON.stringify(toolResult)).toMatch(/disabled by your approval settings/);

    expect(result.events.map((event) => event.type)).toContain("tool_execution_start");
    expect(result.events.map((event) => event.type)).toContain("tool_execution_end");

    const sessionMessages = parseSessionEntries(result.sessionText)
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.message.role);
    expect(sessionMessages).toEqual(["user", "assistant", "toolResult", "assistant"]);
  });

  it("does not write plan state for a normal chat turn that starts with /plan", async () => {
    const result = await runAgentReplay({
      prompt: "/plan outline the vault cleanup",
      settings: { mode: "safe" },
      turns: [replayTextTurn("Here is a plain chat outline.", { label: "normal reply" })],
    });

    expect(result.settings.mode).toBe("safe");
    expect(result.sessionText).not.toMatch(/plan_tracker/);
    expect(result.sessionText).not.toMatch(/PLAN_COMPLETE/);
    expect(result.sessionText).not.toMatch(/"mode"\s*:\s*"plan"/);
    expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("replays parent and subagent turns in exact stream-call order", async () => {
    const result = await runAgentReplay({
      prompt: "Use a subagent to check my inbox",
      turns: [
        replayToolCallTurn(
          "call-1",
          "subagent",
          { agent: "explorer", task: "summarize the inbox" },
          { label: "parent dispatch" },
        ),
        replayTextTurn("Inbox has 3 open threads.", {
          label: "explorer child",
          usage: { input: 2, output: 3, totalTokens: 5 },
        }),
        replayTextTurn("All done.", { label: "parent final" }),
      ],
    });

    expect(result.calls.map((call) => call.label)).toEqual(["parent dispatch", "explorer child", "parent final"]);
    expect(result.calls[0].toolNames).toContain("subagent");
    expect(result.calls[1].systemPrompt).toMatch(/explorer subagent/i);
    expect(result.calls[2].messageCount).toBeGreaterThan(result.calls[0].messageCount);

    const toolResult = result.messages.find((message) => message.role === "toolResult");
    expect(toolResult).toMatchObject({ role: "toolResult", toolCallId: "call-1", toolName: "subagent", isError: false });
    expect(JSON.stringify(toolResult)).toContain("Inbox has 3 open threads.");
    expect(result.service.getSessionUsage().totalTokens).toBe(5);
  });

});
