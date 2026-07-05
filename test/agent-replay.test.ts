import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { parseSessionEntries } from "../src/session/jsonl";
import { replayTextTurn, replayToolCallTurn } from "../src/agent/replay-stream";
import { DEFAULT_SETTINGS } from "../src/settings";
import { runAgentReplay } from "./helpers/agent-replay";

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "agentic-chat-replay-"));
  tempRoots.push(root);
  return root;
}

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

  it("replays repeated external inspection as cached session evidence for trace mining", async () => {
    const externalRoot = await tempDir();
    await mkdir(path.join(externalRoot, "repos/service-a"), { recursive: true });
    await writeFile(path.join(externalRoot, "repos/service-a/package.json"), '{"name":"service-a"}\n');

    const previousRequire = (globalThis as { require?: unknown }).require;
    (globalThis as { require?: unknown }).require = createRequire(import.meta.url);
    try {
      const result = await runAgentReplay({
        prompt: "Inspect the service manifest twice to verify cache behavior.",
        settings: {
          external: {
            ...DEFAULT_SETTINGS.external,
            enabled: true,
            rootPath: externalRoot,
            approval: "allow",
          },
        },
        turns: [
          replayToolCallTurn(
            "ext-1",
            "external_inspect",
            { action: "read", path: "repos/service-a/package.json" },
            { label: "first external read" },
          ),
          replayToolCallTurn(
            "ext-2",
            "external_inspect",
            { action: "read", path: "repos/service-a/package.json" },
            { label: "second external read" },
          ),
          replayToolCallTurn(
            "ext-3",
            "external_inspect",
            { action: "read", path: "repos/service-a/package.json" },
            { label: "third external read" },
          ),
          replayTextTurn("The repeated read returned from cache; no more rereads needed.", { label: "final" }),
        ],
      });

      const entries = parseSessionEntries(result.sessionText);
      const cachedResult = entries.find(
        (entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.details?.cached === true,
      );
      expect(cachedResult).toBeDefined();
      expect(JSON.stringify(cachedResult)).toContain("external_inspect cache hit");
      const suppressedResult = entries.find(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "toolResult" &&
          entry.message.details?.cacheReplaySuppressed === true,
      );
      expect(suppressedResult).toBeDefined();
      expect(JSON.stringify(suppressedResult)).toContain("external_inspect duplicate guard");
      expect(JSON.stringify(suppressedResult)).not.toContain('"name":"service-a"');

      const sessionFile = path.join(await tempDir(), "session.jsonl");
      await writeFile(sessionFile, result.sessionText);
      const analyzer = await import(pathToFileURL(path.join(process.cwd(), "scripts/analyze-session-trace.mjs")).href) as {
        analyzePath: (target: string) => {
          aggregate: {
            cacheHits: number;
            repeatedExternalPathActions: Array<{ key: string; count: number }>;
          };
        };
      };
      const trace = analyzer.analyzePath(sessionFile);

      expect(trace.aggregate.cacheHits).toBe(2);
      expect(trace.aggregate.repeatedExternalPathActions).toContainEqual({
        key: "read repos/service-a/package.json",
        count: 3,
      });
    } finally {
      if (previousRequire === undefined) {
        delete (globalThis as { require?: unknown }).require;
      } else {
        (globalThis as { require?: unknown }).require = previousRequire;
      }
    }
  });
});
