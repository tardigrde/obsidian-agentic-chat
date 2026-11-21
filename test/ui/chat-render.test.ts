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

// Each test mounts a fresh view, so "last" is the newest match in the transcript.
const last = <T extends HTMLElement = HTMLElement>(selector: string) => (ui.$$(selector).at(-1) as T | undefined) ?? null;
// The newest turn: its activity line and the messages after it.
const lastAll = (selector: string) => {
  const all = ui.$$(selector);
  const turns = ui.$$('[data-ac="activity"]');
  const start = turns.at(-1);
  return start ? all.filter((el) => !!(start.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) || start.contains(el)) : all;
};
const head = () => text(last('[data-ac="activity-head"] .agentic-chat-activity-summary'));
const activityState = () => last('[data-ac="activity"]')?.getAttribute("data-ac-state");

beforeEach(async () => {
  // Fake only the clocks the reasoning and step timers read; DOM tasks stay real.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
  ui = await mountChatView();
});

afterEach(async () => {
  await ui.close();
  vi.useRealTimers();
});

describe("activity line", () => {
  it("shows Thinking with a spinner at message_start; a text-only turn hides the line when it ends", async () => {
    startAssistantTurn();
    expect(ui.$$('[data-ac="activity"]')).toHaveLength(1);
    expect(head()).toBe("Thinking…");
    expect(activityState()).toBe("running");
    expect(ui.$$('[data-ac="activity-head"] .agentic-chat-spinner')).toHaveLength(1);

    ui.emit(streamDelta("text_delta", "first token"));
    ui.emit(assistantEndText("first token"));
    ui.emit({ type: "agent_end" });
    await settle();
    expect(activityState()).toBe("done");
    expect(last('[data-ac="activity"]')?.classList.contains("is-hidden")).toBe(true);
    expect(ui.$$(".agentic-chat-spinner")).toHaveLength(0);
  });

  it("folds reasoning in as the first body entry, settled with its time", async () => {
    startAssistantTurn();
    ui.emit(streamDelta("thinking_delta", "trace reasoning step one"));
    vi.advanceTimersByTime(1_500);
    await settle();
    expect(text(last(".agentic-chat-thought-label"))).toBe("Thinking");
    expect(text(last(".agentic-chat-thought-text"))).toBe("trace reasoning step one");

    ui.emit(streamDelta("text_delta", "measured answer"));
    ui.emit(assistantEndText("measured answer"));
    ui.emit({ type: "agent_end" });
    await settle();
    expect(text(last(".agentic-chat-thought.is-done .agentic-chat-thought-label"))).toBe("Thought");
    expect(text(last(".agentic-chat-thought.is-done .agentic-chat-thought-time"))).toBe("2s");
    expect(head()).toBe("Thought");
    expect(last('[data-ac="activity"]')?.classList.contains("is-hidden")).toBe(false);
    // U3 #3: the reasoning is a row of the step timeline, in event order.
    const steps = last('[data-ac="activity-body"] .agentic-chat-activity-steps');
    expect(steps?.firstElementChild?.classList.contains("agentic-chat-thought")).toBe(true);
  });

  it("a near-instant trace settles to Thought with no time", async () => {
    startAssistantTurn();
    ui.emit(streamDelta("thinking_delta", "cached trace"));
    ui.emit(assistantEndText("cached answer"));
    await settle();
    expect(text(last(".agentic-chat-thought.is-done .agentic-chat-thought-label"))).toBe("Thought");
    expect(text(last(".agentic-chat-thought.is-done .agentic-chat-thought-time"))).toBe("");
  });

  it("an abort mid-thinking leaves no spinner and no empty entry", async () => {
    startAssistantTurn();
    ui.emit(assistantEndEmpty);
    ui.emit({ type: "agent_end" });
    await settle();
    expect(ui.$$(".agentic-chat-spinner")).toHaveLength(0);
    expect(ui.$$(".agentic-chat-thought:not(.is-empty)")).toHaveLength(0);
    expect(activityState()).toBe("done");
  });

  it("is one line per turn: 3 reads and 1 failed fetch read `Read 3 notes · 1 failed` with 4 rows", async () => {
    startAssistantTurn();
    for (const [id, name, args, error] of [
      ["r1", "read", { path: "A.md" }, false],
      ["r2", "read", { path: "B.md" }, false],
      ["f1", "fetch_url", { url: "https://x.example/p" }, true],
      ["r3", "read", { path: "C.md" }, false],
    ] as const) {
      ui.emit(toolStart(id, name, args));
      expect(head()).toMatch(/^(Reading|Fetching) /);
      ui.emit(toolEnd(id, error ? "timed out" : "ok", error));
    }
    ui.emit(assistantEndEmpty);
    // A second assistant message in the same turn shares the line.
    ui.emit({ type: "message_start", message: { role: "assistant", content: [] } });
    ui.emit(assistantEndText("done reading"));
    ui.emit({ type: "agent_end" });
    await settle();
    expect(ui.$$('[data-ac="activity"]')).toHaveLength(1);
    expect(head()).toBe("Read 3 notes");
    expect(text(last(".agentic-chat-activity-fail"))).toBe("· 1 failed");
    expect(ui.$$('[data-ac="step"]').map((row) => row.getAttribute("data-ac-state"))).toEqual(["done", "done", "error", "done"]);
    // Collapsed by default; the failed row is open to show why.
    expect(last('[data-ac="activity-head"]')?.getAttribute("aria-expanded")).toBe("false");
    expect(ui.$$('[data-ac="step"].is-open')).toHaveLength(1);
    expect(text(ui.$('[data-ac="step"].is-error .agentic-chat-step-section-label'))).toBe("Error");
    last<HTMLButtonElement>('[data-ac="activity-head"]')?.click();
    expect(last('[data-ac="activity-head"]')?.getAttribute("aria-expanded")).toBe("true");
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
    ui.emit({ type: "agent_end" });
    await settle();

    expect(ui.$$(".agentic-chat-source-chip-name").map(text)).toEqual(["SourceA", "SourceB", "SourceC"]);
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
    ui.emit({ type: "agent_end" });
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
    expect(activityState()).toBe("done");
    expect(head()).toBe("Read 1 note");
    expect(text(last(".agentic-chat-source-chip-name"))).toBe("SourceA");
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

const blockSummary = () => text(last('[data-ac="subagents"] .agentic-chat-subagent-block-summary'));

describe("subagent section (U4 #5)", () => {
  it("summarizes the children in its head; Stop only on a running row; cost once settled", async () => {
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
    expect(blockSummary()).toBe("Subagents · 1 running · 1 done");
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
    expect(blockSummary()).toBe("Subagents · 2 done");
    expect(lastAll(".agentic-chat-subagent .agentic-chat-subagent-stop")).toHaveLength(0);
    expect(lastAll(".agentic-chat-subagent-time").map(text)).toEqual(["2m 5s", "1m 30s"]);
    expect(lastAll(".agentic-chat-subagent-meta").map(text)).toEqual(["$0.01", "$0.0060"]);
  });

  it("a progress tick keeps the section and the row as the user left them", async () => {
    startAssistantTurn();
    ui.emit(toolStart("t-tick", "subagent", { agent: "explorer", task: "map" }));
    const tick = (summary: string) =>
      ui.emit({
        type: "tool_execution_update",
        toolCallId: "t-tick",
        partialResult: {
          details: { kind: "subagent", children: [{ agent: "explorer", task: "task 1", status: "running", stopId: "s0", transcript: [], summary }] },
        },
      });
    tick("");
    const block = last('[data-ac="subagents"]');
    const child = last(".agentic-chat-subagent") as HTMLDetailsElement;
    // Collapsed by default, also while running.
    expect(block?.classList.contains("is-open")).toBe(false);
    expect(child.open).toBe(false);
    (last('[data-ac="subagents-head"]') as HTMLElement).click();
    child.open = true;
    tick("still going");
    expect(block?.classList.contains("is-open")).toBe(true);
    expect((last(".agentic-chat-subagent") as HTMLDetailsElement).open).toBe(true);
    child.open = false;
    tick("more");
    expect((last(".agentic-chat-subagent") as HTMLDetailsElement).open).toBe(false);
  });

  it("labels a stopped child as stopped, not failed, and never shows a green check", async () => {
    startAssistantTurn();
    const stopped = [{ agent: "explorer", task: "hang", status: "aborted", transcript: [], summary: "Stopped by user" }];
    ui.emit(toolStart("t-stop", "subagent", { agent: "explorer", task: "hang" }));
    ui.emit({ type: "tool_execution_update", toolCallId: "t-stop", partialResult: { details: { kind: "subagent", children: stopped } } });
    expect(text(last(".agentic-chat-subagent-status"))).toBe("stopped");
    expect(blockSummary()).toBe("Subagents · 1 stopped");
    // A stopped dispatch settles as a normal result (isError false); the red icon
    // comes from the persisted child statuses.
    ui.emit({
      type: "tool_execution_end",
      toolCallId: "t-stop",
      result: { content: [{ type: "text", text: 'Subagent "explorer" was stopped: Stopped by user' }], details: { kind: "subagent", children: stopped } },
      isError: false,
    });
    expect(cls(last('[data-ac="step"] .agentic-chat-status-icon svg'))).toContain("alert-circle");
    expect(cls(last(".agentic-chat-step"))).toContain("is-error");
  });

  it("rehydrates a done dispatch from tool_execution_end alone, collapsed with its report", () => {
    dispatch({
      id: "t-r1-done",
      contentText: "summary text",
      isError: false,
      children: [{ agent: "explorer", task: "map the vault", status: "done", summary: "found 3 notes", durationMs: 42_000, usage: { input: 1000, output: 500, totalTokens: 1500, costUsd: 0.003 } }],
    });
    expect(cls(last(".agentic-chat-step"))).toContain("is-done");
    expect(cls(last(".agentic-chat-step"))).not.toContain("is-running");
    expect(text(last(".agentic-chat-subagent-log"))).toContain("found 3 notes");
    expect(blockSummary()).toBe("Subagents · 1 done");
    expect(lastAll(".agentic-chat-subagent-stop")).toHaveLength(0);
    expect(last('[data-ac="subagents-head"]')?.getAttribute("aria-expanded")).toBe("false");
  });

  it("rehydrates an aborted dispatch as stopped (red) and an error dispatch as failed", () => {
    dispatch({
      id: "t-r1-abort",
      contentText: 'Subagent "explorer" was stopped: Stopped by user',
      isError: false,
      children: [{ agent: "explorer", task: "hang", status: "aborted", summary: "Stopped by user", durationMs: 5000 }],
    });
    expect(cls(last('[data-ac="step"] .agentic-chat-status-icon svg'))).toContain("alert-circle");
    expect(blockSummary()).toBe("Subagents · 1 stopped");
    expect(text(last(".agentic-chat-subagent-status"))).toBe("stopped");

    dispatch({
      id: "t-r1-error",
      contentText: 'Subagent "explorer" failed: disk full',
      isError: true,
      children: [{ agent: "explorer", task: "bad", status: "error", summary: "disk full", durationMs: 1000 }],
    });
    expect(cls(last(".agentic-chat-step"))).toContain("is-error");
    expect(blockSummary()).toBe("Subagents · 1 failed");
  });

  it("opens a collapsed replayed section and keeps Stop hidden", () => {
    dispatch({
      id: "t-r1-toggle",
      contentText: "toggle summary",
      isError: false,
      children: [{ agent: "explorer", task: "toggle me", status: "done", summary: "toggle summary", durationMs: 1000 }],
    });
    const toggle = last('[data-ac="subagents-head"]');
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    toggle?.click();
    expect(last('[data-ac="subagents-head"]')?.getAttribute("aria-expanded")).toBe("true");
    expect(lastAll(".agentic-chat-subagent-stop")).toHaveLength(0);
    expect(text(last(".agentic-chat-subagent-log"))).toContain("toggle summary");
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
