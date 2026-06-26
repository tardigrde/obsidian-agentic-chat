import { describe, expect, it } from "vitest";
import { createAskUserTool, type AskUserDetails } from "../src/tools/ask-user-tool";

describe("ask_user tool", () => {
  it("asks the user and returns their answer to the model", async () => {
    const updates: AskUserDetails[] = [];
    const tool = createAskUserTool(async (request) => {
      expect(request).toEqual({ question: "Which folder?", choices: ["Inbox", "Archive"] });
      return "Inbox";
    });

    const result = await tool.execute(
      "call-1",
      { question: " Which folder? ", choices: ["Inbox", "Archive", "Inbox", " "] },
      undefined,
      (partial) => updates.push(partial.details),
    );

    expect(updates).toEqual([
      { kind: "ask_user", status: "waiting", question: "Which folder?", choices: ["Inbox", "Archive"] },
    ]);
    expect(result.content[0]).toEqual({ type: "text", text: "User answered: Inbox" });
    expect(result.details).toEqual({
      kind: "ask_user",
      status: "answered",
      question: "Which folder?",
      choices: ["Inbox", "Archive"],
      answer: "Inbox",
    });
  });

  it("rejects an empty question before asking", async () => {
    const tool = createAskUserTool(async () => "answer");
    await expect(tool.execute("call-1", { question: "   " })).rejects.toThrow(/non-empty question/i);
  });

  it("passes the abort signal to the user handler", async () => {
    const controller = new AbortController();
    const tool = createAskUserTool(async (_request, signal) => {
      expect(signal).toBe(controller.signal);
      throw new Error("cancelled");
    });

    await expect(tool.execute("call-1", { question: "Continue?" }, controller.signal)).rejects.toThrow(/cancelled/);
  });
});
