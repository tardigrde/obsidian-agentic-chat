import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountChatView, seedFile, settle, type MountedChatView } from "./support/mount-chat-view";

/**
 * Rendering of agent events in the real ChatView (happy-dom). These checks
 * moved down from the e2e render specs (beautifului-polish, subagent-replay,
 * inline-images): they inject `handleAgentEvent` and read classes and text, so
 * a real Obsidian adds launch time, not proof. Layout and wiring stay in e2e.
 */

const text = (el: Element | null | undefined): string => el?.textContent ?? "";
const cls = (el: Element | null | undefined): string => el?.getAttribute("class") ?? "";

function streamDelta(type: string, delta: string): Record<string, unknown> {
  return { type: "message_update", assistantMessageEvent: { type, delta } };
}
function toolStart(id: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
  return { type: "tool_execution_start", toolCallId: id, toolName: name, args };
}
function toolEnd(id: string, resultText = "ok", isError = false): Record<string, unknown> {
  return { type: "tool_execution_end", toolCallId: id, result: { output: resultText }, isError };
}
function assistantEndText(body: string): Record<string, unknown> {
  return { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: body }] } };
}
const assistantEndEmpty = { type: "message_end", message: { role: "assistant", content: [] } };

let ui: MountedChatView;

function startAssistantTurn(): void {
  ui.emit({ type: "agent_start" });
  ui.emit({ type: "message_start", message: { role: "assistant", content: [] } });
}

const last = (selector: string) => ui.$(`.agentic-chat-assistant:last-child ${selector}`);
const lastAll = (selector: string) => ui.$$(`.agentic-chat-assistant:last-child ${selector}`);

beforeEach(async () => {
  // Fake only the clocks the reasoning and step timers read; DOM tasks stay real.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
  ui = await mountChatView();
});

afterEach(async () => {
  await ui.close();
  vi.useRealTimers();
});

describe("reasoning pill", () => {
  it("mounts Thinking at message_start and flips to Thought on the first answer delta", async () => {
    startAssistantTurn();
    expect(ui.$$(".agentic-chat-reasoning")).toHaveLength(1);
    expect(ui.$$(".agentic-chat-loading")).toHaveLength(0);
    expect(text(ui.$(".agentic-chat-reasoning-label"))).toBe("Thinking");
    expect(cls(ui.$(".agentic-chat-reasoning"))).not.toContain("is-done");

    vi.advanceTimersByTime(300);
    expect(text(ui.$(".agentic-chat-reasoning-time"))).not.toBe("");

    ui.emit(streamDelta("text_delta", "first token"));
    await settle();
    expect(ui.$(".agentic-chat-reasoning.is-done")).not.toBeNull();
    expect(text(last(".agentic-chat-reasoning-label"))).toBe("Thought");
  });

  it("instant replies flip straight to Thought with no loader ever", async () => {
    startAssistantTurn();
    ui.emit(streamDelta("text_delta", "instant reply"));
    await settle();
    expect(ui.$$(".agentic-chat-loading")).toHaveLength(0);
    expect(last(".agentic-chat-reasoning.is-done")).not.toBeNull();
    expect(text(last(".agentic-chat-reasoning-label"))).toBe("Thought");
  });

  it("settles a live trace to Thought with a final elapsed time and one check icon", async () => {
    startAssistantTurn();
    ui.emit(streamDelta("thinking_delta", "trace reasoning step one"));
    vi.advanceTimersByTime(1_500);
    await settle();
    expect(text(last(".agentic-chat-reasoning-time"))).toBe("1.5s");

    ui.emit(streamDelta("text_delta", "measured answer"));
    ui.emit(assistantEndText("measured answer"));
    await settle();
    expect(text(ui.$(".agentic-chat-reasoning.is-done .agentic-chat-reasoning-label"))).toBe("Thought");
    expect(text(ui.$(".agentic-chat-reasoning-time"))).toBe("1.5s");
    expect(lastAll(".agentic-chat-reasoning.is-done .agentic-chat-reasoning-dot svg")).toHaveLength(1);
    expect(cls(last(".agentic-chat-reasoning-dot svg"))).toContain("check-circle-2");
  });

  it("collapses a near-instant (history-style) turn to a static Thought pill with no timer", async () => {
    startAssistantTurn();
    ui.emit(streamDelta("thinking_delta", "cached trace"));
    ui.emit(assistantEndText("cached answer"));
    await settle();
    expect(text(last(".agentic-chat-reasoning.is-done .agentic-chat-reasoning-label"))).toBe("Thought");
    expect(text(last(".agentic-chat-reasoning-time"))).toBe("");
  });

  it("settles the pill and leaves no loader when the turn aborts mid-thinking", async () => {
    startAssistantTurn();
    expect(text(last(".agentic-chat-reasoning-label"))).toBe("Thinking");
    ui.emit(assistantEndEmpty);
    ui.emit({ type: "agent_end" });
    await settle();
    expect(ui.$$(".agentic-chat-loading")).toHaveLength(0);
    expect(text(last(".agentic-chat-reasoning-label"))).toBe("Thought");
    expect(ui.$$(".agentic-chat-assistant").length).toBeGreaterThan(0);
  });
});

describe("source chips", () => {
  it("renders deduped chips only for read-style tools and opens the note on click", async () => {
    for (const path of ["Notes/SourceA.md", "Notes/SourceB.md", "Notes/SourceC.md", "Notes/Out.md"]) await seedFile(ui.app, path);
    startAssistantTurn();
    for (const [id, name, path] of [
      ["t-read-a", "read", "Notes/SourceA.md"],
      ["t-read-a2", "read", "Notes/SourceA.md"],
      ["t-active", "get_active_note", "Notes/SourceB.md"],
      ["t-edit", "edit", "Notes/SourceC.md"],
      ["t-write", "write", "Notes/Out.md"],
      ["t-del", "delete", "Notes/Gone.md"],
    ]) {
      ui.emit(toolStart(id, name, { path }));
      ui.emit(toolEnd(id));
    }
    ui.emit(assistantEndText("summarised the notes"));
    await settle();

    expect(ui.$$(".agentic-chat-source-chip-name").map(text)).toEqual(["SourceA.md", "SourceB.md", "SourceC.md"]);
    ui.$<HTMLButtonElement>(".agentic-chat-source-chip")?.click();
    await settle();
    expect(ui.app.workspace.opened).toEqual(["Notes/SourceA.md"]);
  });

  it("caps the chip row at 8 with a +N overflow counter", async () => {
    startAssistantTurn();
    for (let index = 0; index < 10; index += 1) {
      ui.emit(toolStart(`t-cap-${index}`, "read", { path: `Notes/SourceD${index}.md` }));
      ui.emit(toolEnd(`t-cap-${index}`));
    }
    ui.emit(assistantEndText("ten reads"));
    await settle();
    expect(lastAll(".agentic-chat-source-chip")).toHaveLength(8);
    expect(text(last(".agentic-chat-sources-more"))).toBe("+2");
  });

  it("finalizes a text-less tool-only turn without markdown, keeps chips, and settles once", async () => {
    startAssistantTurn();
    ui.emit(toolStart("t-solo", "read", { path: "Notes/SourceA.md" }));
    ui.emit(toolEnd("t-solo"));
    ui.emit(assistantEndEmpty);
    ui.emit({ type: "agent_end" });
    await settle();
    expect(lastAll(".agentic-chat-source-chip")).toHaveLength(1);
    expect(lastAll(".agentic-chat-sources")).toHaveLength(1);
    expect(cls(last(".agentic-chat-reasoning"))).toContain("is-done");
    expect(text(last(".agentic-chat-reasoning-label"))).toBe("Thought");
    expect(text(last(".agentic-chat-source-chip-name"))).toBe("SourceA.md");
    expect(text(last(".agentic-chat-text"))).toBe("");
  });
});

type Child = Record<string, unknown>;

function dispatch(opts: { id: string; children: Child[]; isError: boolean; contentText: string }): void {
  startAssistantTurn();
  ui.emit(toolStart(opts.id, "subagent", { agent: "explorer", task: "task" }));
  ui.emit({
    type: "tool_execution_end",
    toolCallId: opts.id,
    result: { content: [{ type: "text", text: opts.contentText }], details: { kind: "subagent", children: opts.children } },
    isError: opts.isError,
  });
  ui.emit(assistantEndEmpty);
  ui.emit({ type: "agent_end" });
}

describe("subagent dispatch card", () => {
  it("shows one aggregated status pill with exclusive Stop/Done and a usage readout", async () => {
    startAssistantTurn();
    ui.emit(toolStart("t-sub", "subagent", { agent: "explorer", task: "map the vault" }));
    ui.emit({
      type: "tool_execution_update",
      toolCallId: "t-sub",
      partialResult: {
        details: {
          kind: "subagent",
          children: [
            { agent: "explorer", task: "task 1", status: "running", stopId: "s0", transcript: [], summary: "" },
            { agent: "explorer", task: "task 2", status: "done", transcript: [], summary: "summary" },
          ],
        },
      },
    });
    expect(text(last(".agentic-chat-step-status"))).toBe("Running…");
    expect(lastAll(".agentic-chat-subagent .agentic-chat-subagent-stop")).toHaveLength(1);

    ui.emit({
      type: "tool_execution_update",
      toolCallId: "t-sub",
      partialResult: {
        details: {
          kind: "subagent",
          children: [
            { agent: "explorer", task: "task 1", status: "done", transcript: [], summary: "summary", durationMs: 125_000, usage: { input: 4_000, output: 800, totalTokens: 4_800, costUsd: 0.012 } },
            { agent: "explorer", task: "task 2", status: "done", transcript: [], summary: "summary", durationMs: 90_000, usage: { input: 2_000, output: 500, totalTokens: 2_500, costUsd: 0.006 } },
          ],
        },
      },
    });
    expect(text(last(".agentic-chat-step-status"))).toBe("Done");
    expect(lastAll(".agentic-chat-subagent .agentic-chat-subagent-stop")).toHaveLength(0);
    const meta = lastAll(".agentic-chat-subagent-meta").map(text);
    expect(meta).toHaveLength(2);
    for (const line of meta) {
      expect(line).toMatch(/tok/);
      expect(line).toContain("$");
    }
  });

  it("labels a stopped child as stopped, not failed, and never shows a green check", async () => {
    startAssistantTurn();
    const stopped = [{ agent: "explorer", task: "hang", status: "aborted", transcript: [], summary: "Stopped by user" }];
    ui.emit(toolStart("t-stop", "subagent", { agent: "explorer", task: "hang" }));
    ui.emit({ type: "tool_execution_update", toolCallId: "t-stop", partialResult: { details: { kind: "subagent", children: stopped } } });
    expect(text(last(".agentic-chat-subagent-status"))).toBe("stopped");
    expect(text(last(".agentic-chat-step-status"))).toBe("Stopped");
    // A stopped dispatch settles as a normal result (isError false); the red icon
    // comes from the persisted child statuses.
    ui.emit({
      type: "tool_execution_end",
      toolCallId: "t-stop",
      result: { content: [{ type: "text", text: 'Subagent "explorer" was stopped: Stopped by user' }], details: { kind: "subagent", children: stopped } },
      isError: false,
    });
    expect(cls(last(".agentic-chat-step-icon svg"))).toContain("x-circle");
    expect(cls(last(".agentic-chat-step"))).toContain("is-error");
  });

  it("rehydrates a done dispatch from tool_execution_end alone, collapsed with its summary", () => {
    dispatch({
      id: "t-r1-done",
      contentText: "summary text",
      isError: false,
      children: [{ agent: "explorer", task: "map the vault", status: "done", summary: "found 3 notes", durationMs: 42_000, usage: { input: 1000, output: 500, totalTokens: 1500, costUsd: 0.003 } }],
    });
    expect(cls(last(".agentic-chat-step"))).toContain("is-done");
    expect(cls(last(".agentic-chat-step"))).not.toContain("is-running");
    expect(text(last(".agentic-chat-subagent pre"))).toContain("found 3 notes");
    expect(text(last(".agentic-chat-step-status"))).toBe("Done");
    expect(lastAll(".agentic-chat-subagent-stop")).toHaveLength(0);
    expect(last(".agentic-chat-step-toggle")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("rehydrates an aborted dispatch as stopped (red) and an error dispatch as failed", () => {
    dispatch({
      id: "t-r1-abort",
      contentText: 'Subagent "explorer" was stopped: Stopped by user',
      isError: false,
      children: [{ agent: "explorer", task: "hang", status: "aborted", summary: "Stopped by user", durationMs: 5000 }],
    });
    expect(cls(last(".agentic-chat-step-icon svg"))).toContain("x-circle");
    expect(text(last(".agentic-chat-step-status"))).toBe("Stopped");
    expect(text(last(".agentic-chat-subagent-status"))).toBe("stopped");

    dispatch({
      id: "t-r1-error",
      contentText: 'Subagent "explorer" failed: disk full',
      isError: true,
      children: [{ agent: "explorer", task: "bad", status: "error", summary: "disk full", durationMs: 1000 }],
    });
    expect(cls(last(".agentic-chat-step"))).toContain("is-error");
    expect(text(last(".agentic-chat-step-status"))).toBe("Failed");
  });

  it("toggles a collapsed replay card open and keeps Stop hidden", () => {
    dispatch({
      id: "t-r1-toggle",
      contentText: "toggle summary",
      isError: false,
      children: [{ agent: "explorer", task: "toggle me", status: "done", summary: "toggle summary", durationMs: 1000 }],
    });
    const toggle = last(".agentic-chat-step-toggle");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    toggle?.click();
    expect(last(".agentic-chat-step-toggle")?.getAttribute("aria-expanded")).toBe("true");
    expect(lastAll(".agentic-chat-subagent-stop")).toHaveLength(0);
    expect(text(last(".agentic-chat-subagent pre"))).toContain("toggle summary");
  });
});

describe("inline images", () => {
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const IMAGE_PATH = "E2E Images/inline-pic.png";

  it("renders vault image embeds in assistant markdown and leaves code untouched", async () => {
    await seedFile(ui.app, IMAGE_PATH, "png");
    startAssistantTurn();
    ui.emit(assistantEndText(["Wiki embed: ![[inline-pic.png]]", "", `Markdown: ![pic](${encodeURI(IMAGE_PATH)})`, "", "Code span: `![[inline-pic.png]]`"].join("\n")));
    ui.emit({ type: "agent_end", messages: [] });
    await settle();
    const srcs = lastAll("img").map((img) => img.getAttribute("src") ?? "");
    expect(srcs).toHaveLength(2);
    for (const src of srcs) expect(src).toMatch(/^app:\/\//);
    expect(ui.$$(".agentic-chat-assistant img.agentic-chat-image").length).toBeGreaterThanOrEqual(2);
    expect(text(last("code"))).toBe("![[inline-pic.png]]");
  });

  it("shows one openable thumbnail per attached image and does not echo the sent user turn", async () => {
    await seedFile(ui.app, IMAGE_PATH, "png");
    const view = ui.view as unknown as { renderOutgoingUserMessage: (text: string, attachments: string[], images?: unknown[]) => void };
    view.renderOutgoingUserMessage("what is in this picture?", [IMAGE_PATH], [{ type: "image", data: PNG, mimeType: "image/png" }]);
    const img = ui.$$(".agentic-chat-user").at(-1)?.querySelector<HTMLElement>("img.is-openable");
    expect(img?.getAttribute("src")).toMatch(/^app:\/\//);
    expect(img?.getAttribute("role")).toBe("button");
    expect(img?.getAttribute("tabindex")).toBe("0");

    img?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    img?.click();
    await settle();
    expect(ui.app.workspace.opened).toEqual([IMAGE_PATH, IMAGE_PATH]);

    const before = ui.$$(".agentic-chat-user").length;
    ui.emit({
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: "what is in this picture?" }, { type: "image", data: PNG, mimeType: "image/png" }] },
    });
    expect(ui.$$(".agentic-chat-user")).toHaveLength(before);
  });

  it("renders a replayed vision block as a data-URL thumbnail", () => {
    ui.emit({
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: "from history" }, { type: "image", data: PNG, mimeType: "image/png" }] },
    });
    const srcs = Array.from(ui.$$(".agentic-chat-user").at(-1)?.querySelectorAll("img") ?? []).map((img) => img.getAttribute("src"));
    expect(srcs).toEqual([`data:image/png;base64,${PNG}`]);
  });
});
