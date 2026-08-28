import { browser, expect, $ } from "@wdio/globals";
import { before, describe, it } from "mocha";

/**
 * R1 smoke — persisted subagent dispatch replay (no model, no updateStep):
 * verifies that a `tool_execution_end` with `details` alone rehydrates a
 * collapsed dispatch card, matching Codex `ReplayKind` parity and the live
 * `tool_execution_update` path. Local-only.
 */

const VIEW_TYPE_AGENT_CHAT = "agentic-chat-chat-view";

interface ProbeQuery {
  key: string;
  selector: string;
  attr?: string;
  all?: boolean;
}
type ProbeResult = Record<string, string | string[]>;

async function probe(query: ProbeQuery): Promise<ProbeResult> {
  return (await browser.execute((q) => {
    const out: Record<string, unknown> = {};
    const attr = q.attr;
    const nodes = q.all ? Array.from(document.querySelectorAll(q.selector)) : [document.querySelector(q.selector)];
    const values = nodes.filter(Boolean) as Element[];
    const read = (el: Element): string => (attr ? el.getAttribute(attr) ?? "" : (el as HTMLElement).innerText ?? (el.textContent ?? ""));
    out[q.key] = q.all ? values.map(read) : values.length > 0 ? read(values[0]) : "";
    return out;
  }, query)) as ProbeResult;
}

async function emit(event: Record<string, unknown>): Promise<void> {
  await browser.executeObsidian(
    async ({ app }, viewType, ev) => {
      const view = app.workspace.getLeavesOfType(viewType)[0]?.view as unknown as {
        handleAgentEvent?: (event: unknown) => void;
      };
      if (!view?.handleAgentEvent) throw new Error(`chat view missing handleAgentEvent for ${viewType}`);
      view.handleAgentEvent(ev);
    },
    VIEW_TYPE_AGENT_CHAT,
    event,
  );
}

async function openChat(): Promise<void> {
  await browser.executeObsidianCommand("agentic-chat:open-chat");
  await $(".agentic-chat-view").waitForExist();
}

async function startAssistantTurn(): Promise<void> {
  await emit({ type: "agent_start" });
  await emit({ type: "message_start", message: { role: "assistant", content: [] } });
}

function toolStart(id: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
  return { type: "tool_execution_start", toolCallId: id, toolName: name, args };
}

function assistantEndEmpty(): Record<string, unknown> {
  return { type: "message_end", message: { role: "assistant", content: [] } };
}

describe("R1 subagent replay smoke", function () {
  before(async function () {
    await openChat();
  });

  it("rehydrates a done dispatch from tool_execution_end alone (no updateStep), collapsed with summary", async function () {
    await startAssistantTurn();
    await emit(toolStart("t-r1-done", "subagent", { agent: "explorer", task: "map the vault" }));
    // Replay path: no tool_execution_update, only end with persisted details (stripped transcript/stopId, bounded).
    await emit({
      type: "tool_execution_end",
      toolCallId: "t-r1-done",
      result: {
        content: [{ type: "text", text: "summary text" }],
        details: {
          kind: "subagent",
          children: [
            {
              agent: "explorer",
              task: "map the vault",
              status: "done",
              summary: "found 3 notes",
              durationMs: 42_000,
              usage: { input: 1000, output: 500, totalTokens: 1500, costUsd: 0.003 },
            },
          ],
        },
      },
      isError: false,
    });
    await emit(assistantEndEmpty());
    await emit({ type: "agent_end" });

    // Outer dispatch card exists and is collapsed on reload (ReplayKind parity).
    await browser.waitUntil(
      async () => {
        const card = await probe({ key: "cls", selector: ".agentic-chat-assistant:last-child .agentic-chat-step", attr: "class" });
        return typeof card.cls === "string" && card.cls.includes("agentic-chat-step");
      },
      { timeout: 2000, timeoutMsg: "dispatch card never rendered on replay" },
    );
    const cardCls = await probe({ key: "cls", selector: ".agentic-chat-assistant:last-child .agentic-chat-step", attr: "class" });
    expect(cardCls.cls).toContain("is-done");
    expect(cardCls.cls).not.toContain("is-running");

    // Child summary is rendered expandable inside the card (collapsed details).
    const childSummary = await probe({ key: "text", selector: ".agentic-chat-assistant:last-child .agentic-chat-subagent pre" });
    expect(childSummary.text).toContain("found 3 notes");

    // Aggregate pill shows Done, no Stop button (stopped/aborted only shows Stop while running).
    const pill = await probe({ key: "status", selector: ".agentic-chat-assistant:last-child .agentic-chat-step-status" });
    expect(pill.status).toBe("Done");
    const stopBtns = await probe({ key: "stop", selector: ".agentic-chat-assistant:last-child .agentic-chat-subagent-stop", all: true });
    expect(stopBtns.stop).toEqual([]);

    // Outer card should be collapsed on reload (not auto-opened as live does).
    const toggleAria = await probe({ key: "aria", selector: ".agentic-chat-assistant:last-child .agentic-chat-step-toggle", attr: "aria-expanded" });
    expect(toggleAria.aria).toBe("false");
  });

  it("rehydrates an aborted dispatch as stopped (red) without re-running", async function () {
    await startAssistantTurn();
    await emit(toolStart("t-r1-abort", "subagent", { agent: "explorer", task: "hang" }));
    await emit({
      type: "tool_execution_end",
      toolCallId: "t-r1-abort",
      result: {
        content: [{ type: "text", text: 'Subagent "explorer" was stopped: Stopped by user' }],
        details: {
          kind: "subagent",
          children: [{ agent: "explorer", task: "hang", status: "aborted", summary: "Stopped by user", durationMs: 5000 }],
        },
      },
      isError: false,
    });
    await emit(assistantEndEmpty());
    await emit({ type: "agent_end" });

    const icon = await probe({ key: "icon", selector: ".agentic-chat-assistant:last-child .agentic-chat-step-icon svg", attr: "class" });
    expect(icon.icon).toContain("x-circle");
    const pill = await probe({ key: "pill", selector: ".agentic-chat-assistant:last-child .agentic-chat-step-status" });
    expect(pill.pill).toBe("Stopped");
    const childStatus = await probe({ key: "status", selector: ".agentic-chat-assistant:last-child .agentic-chat-subagent-status" });
    expect(childStatus.status).toBe("stopped");
  });

  it("rehydrates an error dispatch as failed (red) from persisted details", async function () {
    await startAssistantTurn();
    await emit(toolStart("t-r1-error", "subagent", { agent: "explorer", task: "bad" }));
    await emit({
      type: "tool_execution_end",
      toolCallId: "t-r1-error",
      result: {
        content: [{ type: "text", text: 'Subagent "explorer" failed: disk full' }],
        details: {
          kind: "subagent",
          children: [{ agent: "explorer", task: "bad", status: "error", summary: "disk full", durationMs: 1000 }],
        },
      },
      isError: true,
    });
    await emit(assistantEndEmpty());
    await emit({ type: "agent_end" });

    const card = await probe({ key: "cls", selector: ".agentic-chat-assistant:last-child .agentic-chat-step", attr: "class" });
    expect(card.cls).toContain("is-error");
    const pill = await probe({ key: "status", selector: ".agentic-chat-assistant:last-child .agentic-chat-step-status" });
    expect(pill.status).toBe("Failed");
  });

  it("toggles a collapsed replay card open and keeps Stop hidden", async function () {
    await startAssistantTurn();
    await emit(toolStart("t-r1-toggle", "subagent", { agent: "explorer", task: "toggle me" }));
    await emit({
      type: "tool_execution_end",
      toolCallId: "t-r1-toggle",
      result: {
        content: [{ type: "text", text: "toggle summary" }],
        details: {
          kind: "subagent",
          children: [{ agent: "explorer", task: "toggle me", status: "done", summary: "toggle summary", durationMs: 1000 }],
        },
      },
      isError: false,
    });
    await emit(assistantEndEmpty());
    await emit({ type: "agent_end" });

    const ariaBefore = await probe({ key: "aria", selector: ".agentic-chat-assistant:last-child .agentic-chat-step-toggle", attr: "aria-expanded" });
    expect(ariaBefore.aria).toBe("false");
    await browser.execute(() => {
      const toggle = document.querySelector<HTMLElement>(".agentic-chat-assistant:last-child .agentic-chat-step-toggle");
      toggle?.click();
    });
    await browser.waitUntil(
      async () => (await probe({ key: "aria", selector: ".agentic-chat-assistant:last-child .agentic-chat-step-toggle", attr: "aria-expanded" })).aria === "true",
      { timeout: 2000, timeoutMsg: "toggle never expanded" },
    );
    const stopAfter = await probe({ key: "stop", selector: ".agentic-chat-assistant:last-child .agentic-chat-subagent-stop", all: true });
    expect(stopAfter.stop).toEqual([]);
    const summaryAfter = await probe({ key: "text", selector: ".agentic-chat-assistant:last-child .agentic-chat-subagent pre" });
    expect(summaryAfter.text).toContain("toggle summary");
  });

  it("persists stripped details to session file and survives loadSession reload", async function () {
    // Write a synthetic session file with stripped details (no transcript/stopId) and load it — true reload path via JSONL → ChatView.renderTranscript → bubble.endStep.
    const sessionPath = await browser.executeObsidian(async ({ app }) => {
      const now = new Date().toISOString();
      const id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
      const fileTs = now.replace(/[:.]/g, "-");
      const sessionDir = `${app.vault.configDir}/plugins/agentic-chat/sessions`;
      // Ensure dir exists
      const parts = sessionDir.split("/");
      let cur = "";
      for (const seg of parts) {
        cur = cur ? `${cur}/${seg}` : seg;
        if (!(await app.vault.adapter.exists(cur))) await app.vault.adapter.mkdir(cur);
      }
      const path = `${sessionDir}/${fileTs}_${id}.jsonl`;
      const header = { type: "session", version: 1, id, timestamp: now, cwd: "obsidian-vault:test" };
      const userMsg = {
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: now,
        message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() },
      };
      const assistantMsg = {
        type: "message",
        id: "m2",
        parentId: "m1",
        timestamp: now,
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "t-file", name: "subagent", arguments: { agent: "explorer", task: "file task" } }],
        },
      };
      const toolResult = {
        type: "message",
        id: "m3",
        parentId: "m2",
        timestamp: now,
        message: {
          role: "toolResult",
          toolCallId: "t-file",
          toolName: "subagent",
          content: [{ type: "text", text: "file summary" }],
          details: {
            kind: "subagent",
            children: [{ agent: "explorer", task: "file task", status: "done", summary: "file summary", durationMs: 1000, usage: { input: 10, output: 20, totalTokens: 30, costUsd: 0.001 } }],
          },
          isError: false,
        },
      };
      const assistantText = {
        type: "message",
        id: "m4",
        parentId: "m3",
        timestamp: now,
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      };
      const content = [header, userMsg, assistantMsg, toolResult, assistantText].map((e) => JSON.stringify(e)).join("\n") + "\n";
      await app.vault.adapter.write(path, content);
      return path;
    });

    // Sanity: file was written stripped (no transcript/stopId)
    const persistedCheck = await browser.executeObsidian(async ({ app }, path) => {
      const raw = await app.vault.adapter.read(path);
      const lines = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const toolResults = lines.filter((e) => e.type === "message" && (e.message as { role?: string })?.role === "toolResult");
      const last = toolResults.at(-1) as { message?: { details?: { children?: Array<Record<string, unknown>> } } } | undefined;
      return { details: (last?.message as unknown as { details?: unknown })?.details } as const;
    }, sessionPath);
    const children = ((persistedCheck as { details?: { children?: Array<Record<string, unknown>> } }).details?.children ?? []) as Array<Record<string, unknown>>;
    expect(children.length).toBe(1);
    expect(children[0].transcript).toBeUndefined();
    expect(children[0].stopId).toBeUndefined();
    expect(children[0].summary).toBe("file summary");

    await browser.executeObsidian(
      async ({ app }, viewType, sPath) => {
        const view = app.workspace.getLeavesOfType(viewType)[0]?.view as unknown as { loadSession?: (p: string) => Promise<void> };
        if (!view?.loadSession) throw new Error("view.loadSession not found");
        await view.loadSession(sPath);
      },
      VIEW_TYPE_AGENT_CHAT,
      sessionPath,
    );
    await $(".agentic-chat-step").waitForExist({ timeout: 5000, timeoutMsg: "dispatch card missing after loadSession" });
    const summaryAfterReload = await probe({ key: "text", selector: ".agentic-chat-assistant:last-child .agentic-chat-subagent pre" });
    expect(summaryAfterReload.text).toContain("file summary");
    const ariaAfter = await probe({ key: "aria", selector: ".agentic-chat-assistant:last-child .agentic-chat-step-toggle", attr: "aria-expanded" });
    expect(ariaAfter.aria).toBe("false");
  });
});
