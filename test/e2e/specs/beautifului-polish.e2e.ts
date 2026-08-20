import { browser, expect, $ } from "@wdio/globals";
import { before, describe, it } from "mocha";

/**
 * Beautifului chat-polish e2e (deterministic, no model key): drives
 * `view.handleAgentEvent(...)` directly against a real running Obsidian so we
 * cover the DOM/event seams unit tests can't reach — the 150ms-gated thinking
 * loader, the reasoning pill + live elapsed timer, source chips scoped to
 * read-style tools, and the no-text finalize/abort paths. Local-only, cheap.
 */

const VIEW_TYPE_AGENT_CHAT = "agentic-chat-chat-view";
const SOURCE_NOTE = "Notes/SourceA.md";

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

/** Dispatch one agent event through the live view (synchronous). */
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

function streamDelta(type: string, delta: string): Record<string, unknown> {
  return { type: "message_update", assistantMessageEvent: { type, delta } };
}

function toolStart(id: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
  return { type: "tool_execution_start", toolCallId: id, toolName: name, args };
}

function toolEnd(id: string): Record<string, unknown> {
  return { type: "tool_execution_end", toolCallId: id, result: { output: "ok" }, isError: false };
}

function assistantEndText(text: string): Record<string, unknown> {
  return { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } };
}

function assistantEndEmpty(): Record<string, unknown> {
  return { type: "message_end", message: { role: "assistant", content: [] } };
}

describe("agentic-chat beautifului polish", function () {
  before(async function () {
    await browser.executeObsidian(async ({ app, obsidian }, paths, sourceNote) => {
      for (const note of paths) {
        if (!app.vault.getAbstractFileByPath(note)) await app.vault.create(note, `e2e source note: ${note}`);
      }
      const file = app.vault.getAbstractFileByPath(sourceNote);
      if (!(file instanceof obsidian.TFile)) throw new Error(`${sourceNote} was not created`);
    }, ["Notes/SourceA.md", "Notes/SourceB.md", "Notes/SourceC.md", "Notes/Out.md"], SOURCE_NOTE);
    await openChat();
  });

  it("shows the pixel-grid thinking loader only after the 150ms anti-flicker gate and clears it on the first delta", async function () {
    const beforeGate = await browser.executeObsidian(async ({ app }, viewType) => {
      const view = app.workspace.getLeavesOfType(viewType)[0]?.view as unknown as {
        handleAgentEvent?: (event: unknown) => void;
      };
      view?.handleAgentEvent?.({ type: "agent_start" });
      view?.handleAgentEvent?.({ type: "message_start", message: { role: "assistant", content: [] } });
      return document.querySelectorAll(".agentic-chat-loading").length;
    }, VIEW_TYPE_AGENT_CHAT);
    expect(beforeGate).toBe(0);

    await $(".agentic-chat-loading").waitForExist({ timeout: 2_000, timeoutMsg: "loader never appeared after the gate" });
    const loader = await probe({ key: "count", selector: ".agentic-chat-loading-grid .agentic-chat-loading-cell", all: true });
    expect(loader.count).toHaveLength(9);
    const label = await probe({ key: "label", selector: ".agentic-chat-loading-label" });
    expect(label.label).toBe("Thinking");
    const time = await probe({ key: "time", selector: ".agentic-chat-loading-time" });
    expect(String(time.time).length).toBeGreaterThan(0);

    await emit(streamDelta("text_delta", "first token"));
    const afterDelta = await probe({ key: "loading", selector: ".agentic-chat-loading", all: true });
    expect(afterDelta.loading).toEqual([]);
    await browser.waitUntil(
      async () => {
        const text = await probe({ key: "text", selector: ".agentic-chat-assistant:last-child .agentic-chat-text" });
        return text.text.includes("first token");
      },
      { timeout: 2_000, timeoutMsg: "first streamed token never rendered" },
    );
  });

  it("never flashes the loader when the first delta arrives inside the gate", async function () {
    await browser.executeObsidian(
      async ({ app }, viewType, events) => {
        const view = app.workspace.getLeavesOfType(viewType)[0]?.view as unknown as {
          handleAgentEvent?: (event: unknown) => void;
        };
        for (const ev of events as unknown[]) view?.handleAgentEvent?.(ev);
      },
      VIEW_TYPE_AGENT_CHAT,
      [
        { type: "agent_start" },
        { type: "message_start", message: { role: "assistant", content: [] } },
        streamDelta("text_delta", "instant reply"),
      ],
    );

    await browser.pause(400);
    const result = await probe({ key: "loading", selector: ".agentic-chat-loading", all: true });
    expect(result.loading).toEqual([]);
    await browser.waitUntil(
      async () => {
        const text = await probe({ key: "text", selector: ".agentic-chat-assistant:last-child .agentic-chat-text" });
        return text.text.includes("instant reply");
      },
      { timeout: 2_000, timeoutMsg: "in-gate delta never rendered" },
    );
  });

  it("live reasoning settles to Thought with a final elapsed timer once the turn renders", async function () {
    await startAssistantTurn();
    await emit(streamDelta("thinking_delta", "trace reasoning step one"));

    const present = await probe({ key: "text", selector: ".agentic-chat-reasoning" });
    expect(present.text.length).toBeGreaterThan(0);
    const label = await probe({ key: "label", selector: ".agentic-chat-assistant:last-child .agentic-chat-reasoning-label" });
    expect(label.label).toBe("Thinking");
    const done = await probe({ key: "cls", selector: ".agentic-chat-assistant:last-child .agentic-chat-reasoning", attr: "class" });
    expect(done.cls).not.toContain("is-done");

    await browser.pause(250);
    const time = await probe({ key: "time", selector: ".agentic-chat-assistant:last-child .agentic-chat-reasoning-time" });
    expect(time.time.length).toBeGreaterThan(0);
    await emit(streamDelta("text_delta", "measured answer"));
    await emit(assistantEndText("measured answer"));

    await $(".agentic-chat-reasoning.is-done").waitForExist({ timeout: 2_000, timeoutMsg: "reasoning never settled" });
    const settled = await probe({ key: "label", selector: ".agentic-chat-reasoning.is-done .agentic-chat-reasoning-label" });
    expect(settled.label).toBe("Thought");
    const settledTime = await probe({ key: "time", selector: ".agentic-chat-reasoning-time" });
    expect(settledTime.time.length).toBeGreaterThan(0);
  });

  it("history-style near-instant turns collapse to a static Reasoning pill with no timer", async function () {
    await browser.executeObsidian(
      async ({ app }, viewType, events) => {
        const view = app.workspace.getLeavesOfType(viewType)[0]?.view as unknown as {
          handleAgentEvent?: (event: unknown) => void;
        };
        for (const ev of events as unknown[]) view?.handleAgentEvent?.(ev);
      },
      VIEW_TYPE_AGENT_CHAT,
      [
        { type: "agent_start" },
        { type: "message_start", message: { role: "assistant", content: [] } },
        streamDelta("thinking_delta", "cached trace"),
        assistantEndText("cached answer"),
      ],
    );

    await $(".agentic-chat-reasoning.is-done").waitForExist({ timeout: 2_000, timeoutMsg: "reasoning never settled" });
    const settled = await probe({ key: "label", selector: ".agentic-chat-assistant:last-child .agentic-chat-reasoning.is-done .agentic-chat-reasoning-label" });
    expect(["Reasoning", "Thought"]).toContain(settled.label);
    const settledTime = await probe({ key: "time", selector: ".agentic-chat-assistant:last-child .agentic-chat-reasoning-time" });
    if (settled.label === "Reasoning") expect(settledTime.time).toBe("");
    else expect(settledTime.time.length).toBeGreaterThan(0);
  });

  it("renders deduped source chips only for read-style tools and opens the note on click", async function () {
    await startAssistantTurn();
    await emit(toolStart("t-read-a", "read", { path: "Notes/SourceA.md" }));
    await emit(toolEnd("t-read-a"));
    await emit(toolStart("t-read-a2", "read", { path: "Notes/SourceA.md" }));
    await emit(toolEnd("t-read-a2"));
    await emit(toolStart("t-active", "get_active_note", { path: "Notes/SourceB.md" }));
    await emit(toolEnd("t-active"));
    await emit(toolStart("t-edit", "edit", { path: "Notes/SourceC.md" }));
    await emit(toolEnd("t-edit"));
    await emit(toolStart("t-write", "write", { path: "Notes/Out.md" }));
    await emit(toolEnd("t-write"));
    await emit(toolStart("t-del", "delete", { path: "Notes/Gone.md" }));
    await emit(toolEnd("t-del"));
    await emit(assistantEndText("summarised the notes"));

    await $(".agentic-chat-source-chip").waitForExist({ timeout: 2_000, timeoutMsg: "source chips never rendered" });
    const names = await probe({ key: "names", selector: ".agentic-chat-source-chip-name", all: true });
    expect(names.names).toEqual(["SourceA.md", "SourceB.md", "SourceC.md"]);

    await browser.execute(() => {
      const chip = document.querySelector<HTMLButtonElement>(".agentic-chat-source-chip");
      if (!chip) throw new Error("source chip not found");
      chip.click();
    });
    await browser.waitUntil(
      async () =>
        await browser.executeObsidian(
          async ({ app }, path) => app.workspace.getActiveFile()?.path === path,
          "Notes/SourceA.md",
        ),
      { timeout: 5_000, timeoutMsg: "clicking a source chip did not open its note" },
    );
  });

  it("caps the chip row at 8 with a +N overflow counter", async function () {
    await startAssistantTurn();
    for (let index = 0; index < 10; index += 1) {
      const id = `t-cap-${index}`;
      await emit(toolStart(id, "read", { path: `Notes/SourceD${index}.md` }));
      await emit(toolEnd(id));
    }
    await emit(assistantEndText("ten reads"));
    await browser.waitUntil(
      async () => {
        const chips = await probe({ key: "names", selector: ".agentic-chat-assistant:last-child .agentic-chat-source-chip", all: true });
        return chips.names.length === 8;
      },
      { timeout: 2_000, timeoutMsg: "chip row never reached its 8-chip cap" },
    );
    const more = await probe({ key: "more", selector: ".agentic-chat-assistant:last-child .agentic-chat-sources-more" });
    expect(more.more).toBe("+2");
  });

  it("finalizes text-less tool-only turns without markdown, keeps chips, and settles chrome exactly once", async function () {
    await startAssistantTurn();
    await emit(toolStart("t-solo", "read", { path: SOURCE_NOTE }));
    await emit(toolEnd("t-solo"));
    await emit(assistantEndEmpty());
    await emit({ type: "agent_end" });

    await browser.waitUntil(
      async () => {
        const chips = await probe({ key: "count", selector: ".agentic-chat-assistant:last-child .agentic-chat-source-chip", all: true });
        const sourceRows = await probe({ key: "count", selector: ".agentic-chat-assistant:last-child .agentic-chat-sources", all: true });
        const loading = await probe({ key: "count", selector: ".agentic-chat-assistant:last-child .agentic-chat-loading", all: true });
        return chips.count.length === 1 && sourceRows.count.length === 1 && loading.count.length === 0;
      },
      { timeout: 2_000, timeoutMsg: "tool-only turn did not settle cleanly" },
    );
    const name = await probe({ key: "name", selector: ".agentic-chat-assistant:last-child .agentic-chat-source-chip-name" });
    expect(name.name).toBe("SourceA.md");
    const text = await probe({ key: "text", selector: ".agentic-chat-assistant:last-child .agentic-chat-text" });
    expect(text.text).toBe("");
  });

  it("aborting mid-loader clears the loader and leaves a settled empty bubble behind", async function () {
    await startAssistantTurn();
    await $(".agentic-chat-loading").waitForExist({ timeout: 2_000, timeoutMsg: "loader never armed" });
    await emit(assistantEndEmpty());
    await emit({ type: "agent_end" });

    const loading = await probe({ key: "count", selector: ".agentic-chat-assistant:last-child .agentic-chat-loading", all: true });
    expect(loading.count).toEqual([]);
    const bubbles = await probe({ key: "count", selector: ".agentic-chat-assistant", all: true });
    expect(bubbles.count.length).toBeGreaterThan(0);
  });
});