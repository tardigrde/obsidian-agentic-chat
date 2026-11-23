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

/** U5 #1: a background child changed after its dispatch call returned. */
const childUpdate = (id: string, child: Child): void =>
  (ui.view as unknown as { transcript: { updateSubagent: (id: string, details: unknown) => void } }).transcript.updateSubagent(id, {
    kind: "subagent",
    children: [child],
  });

const running: Child = { agent: "explorer", task: "map the vault", status: "running", childId: "sa-1", stopId: "sa-1", transcript: [] };

describe("subagent row (U5 #2, #3): one row per child in the activity block", () => {
  it("has no separate Subagents section; the row keeps its spinner and Stop after the parent turn ends", () => {
    dispatch({ id: "t-bg", contentText: 'Started subagent "explorer" as sa-1.', isError: false, children: [running] });
    expect(ui.$$(".agentic-chat-subagent-block")).toHaveLength(0);
    const row = last('[data-ac="step"]');
    expect(cls(row)).toContain("is-subagent");
    expect(cls(row)).toContain("is-child-running");
    expect(row?.querySelector(".agentic-chat-status-icon .agentic-chat-spinner")).not.toBeNull();
    expect(lastAll('[data-ac="subagent-stop"]')).toHaveLength(1);
    // The parent turn is over: its block head is settled, only the child's row runs.
    expect(last('[data-ac="activity"]')?.getAttribute("data-ac-state")).toBe("done");
    // The dispatch's "Started ..." text is not shown as a result section.
    expect(text(row)).not.toContain("Started subagent");
  });

  it("settles the row from a live update after the turn: icon, label, time, cost, report, no Stop", () => {
    dispatch({ id: "t-live", contentText: "started", isError: false, children: [running] });
    childUpdate("t-live", {
      ...running,
      status: "done",
      summary: "found 3 notes",
      durationMs: 125_000,
      usage: { input: 4_000, output: 800, totalTokens: 4_800, costUsd: 0.012 },
    });
    const row = last('[data-ac="step"]');
    expect(cls(row)).not.toContain("is-child-running");
    expect(row?.querySelector(".agentic-chat-status-icon svg")?.getAttribute("class")).toContain("check-circle-2");
    expect(text(row?.querySelector(".agentic-chat-subagent-status"))).toBe("done");
    expect(text(row?.querySelector(".agentic-chat-step-time"))).toBe("2m 5s · $0.01");
    expect(lastAll('[data-ac="subagent-stop"]')).toHaveLength(0);
    expect(text(last('[data-ac="subagent-report"]'))).toContain("found 3 notes");
  });

  it("labels a stopped child as stopped, with a red icon, never a green check", () => {
    dispatch({ id: "t-stop", contentText: "started", isError: false, children: [running] });
    childUpdate("t-stop", { ...running, status: "aborted", summary: "Stopped by user", durationMs: 5000 });
    const row = last('[data-ac="step"]');
    expect(text(row?.querySelector(".agentic-chat-subagent-status"))).toBe("stopped");
    expect(row?.querySelector(".agentic-chat-status-icon svg")?.getAttribute("class")).toContain("alert-circle");
  });

  it("U5 #13: a long report has an Open full report button", () => {
    dispatch({ id: "t-long", contentText: "started", isError: false, children: [running] });
    childUpdate("t-long", { ...running, status: "done", summary: "head of the report…", artifactId: "art-7" });
    expect(lastAll('[data-ac="subagent-open-report"]')).toHaveLength(1);
  });

  it("renders a report message as an event, not as the user's bubble", () => {
    const users = ui.$$(".agentic-chat-user").length;
    ui.emit({
      type: "message_end",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: '<subagent_report id="sa-1" agent="explorer" status="done" call="t-x">\n[BEGIN_UNTRUSTED_TOOL_OUTPUT tool="subagent"]\nfound 3 notes\n[END_UNTRUSTED_TOOL_OUTPUT]\n</subagent_report>',
          },
        ],
      },
    });
    expect(ui.$$(".agentic-chat-user")).toHaveLength(users);
    expect(text(last('[data-ac="subagent-event"] summary'))).toBe("Subagent explorer (sa-1) reported back");
    expect(text(last('[data-ac="subagent-event"] pre'))).toContain("found 3 notes");
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
