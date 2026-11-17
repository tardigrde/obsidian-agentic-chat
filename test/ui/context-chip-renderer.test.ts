import { describe, expect, it } from "vitest";
import { FOLDER_PREFIX } from "../../src/ui/autocomplete";
import type { ContextAttachment } from "../../src/ui/context-attachments";
import { renderContextChips, renderPendingQueueChip } from "../../src/ui/context-chip-renderer";

function root(): HTMLElement {
  return document.createElement("div");
}

function all(parent: HTMLElement, cls: string): HTMLElement[] {
  return Array.from(parent.querySelectorAll<HTMLElement>(`.${cls}`));
}

function chipTextParts(chip: HTMLElement): string[] {
  return Array.from(chip.children).map((child) => child.textContent ?? "").filter(Boolean);
}

function keydown(el: HTMLElement, key: string): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key, cancelable: true }));
}

describe("context chip renderer", () => {
  it("renders the active note and explicit attachments in a stable order", () => {
    const parent = root();
    const selection: ContextAttachment = {
      type: "text",
      id: "selection:1",
      label: "Selection",
      text: "Selected text",
    };

    renderContextChips(parent, {
      activeNotePath: "Daily.md",
      attachments: [`${FOLDER_PREFIX}Projects`, "Images/photo.png", selection],
    }, {
      removeActiveNote: () => {},
      removeAttachment: () => {},
    });

    const chips = all(parent, "agentic-chat-chip");
    expect(chips.map(chipTextParts)).toEqual([
      ["Daily.md", "active"],
      ["Projects"],
      ["Images/photo.png"],
      ["Selection"],
    ]);
    expect(chips[0].className).toContain("is-active-note");
    expect(chips[0].getAttribute("title")).toBe("The active note is attached automatically — remove to stop for this session.");
    expect(chips.some((chip) => chip.className.includes("is-scope"))).toBe(false);
  });

  it("wires remove callbacks to the matching chip", () => {
    const parent = root();
    const events: string[] = [];
    const attachment = `${FOLDER_PREFIX}Projects`;

    renderContextChips(parent, {
      activeNotePath: "Daily.md",
      attachments: [attachment],
    }, {
      removeActiveNote: () => events.push("active"),
      removeAttachment: (entry) => events.push(`attachment:${entry}`),
    });

    for (const remove of all(parent, "agentic-chat-chip-remove")) remove.click();

    expect(events).toEqual(["active", `attachment:${attachment}`]);
  });

  it("renders the queued prompt as a pending chip with a preview", () => {
    const parent = root();

    renderPendingQueueChip(parent, { text: "fix the typo in section 3" }, { cancel: () => {} });

    const chips = all(parent, "agentic-chat-chip");
    expect(chips).toHaveLength(1);
    const chip = chips[0];
    expect(chip.className).toContain("is-pending");
    expect(chipTextParts(chip)).toEqual(["queued", "fix the typo in section 3"]);
    expect(chip.getAttribute("title")).toBe("Sends when the agent finishes. Remove to cancel — the draft stays in the composer.");
  });

  it("truncates a long queued preview", () => {
    const parent = root();

    renderPendingQueueChip(parent, { text: "x".repeat(200) }, { cancel: () => {} });

    const preview = all(parent, "agentic-chat-chip-text");
    expect(preview).toHaveLength(1);
    expect(preview[0].textContent).toHaveLength(81);
    expect(preview[0].textContent?.endsWith("…")).toBe(true);
  });

  it("wires the pending chip remove button to cancel", () => {
    const parent = root();
    let cancelled = 0;

    renderPendingQueueChip(parent, { text: "queued" }, { cancel: () => { cancelled += 1; } });

    all(parent, "agentic-chat-chip-remove")[0].click();

    expect(cancelled).toBe(1);
  });

  it("exposes the pending chip remove control to keyboards", () => {
    const parent = root();
    let cancelled = 0;

    renderPendingQueueChip(parent, { text: "queued" }, { cancel: () => { cancelled += 1; } });

    const remove = all(parent, "agentic-chat-chip-remove")[0];
    expect(remove.getAttribute("role")).toBe("button");
    expect(remove.getAttribute("tabindex")).toBe("0");
    expect(remove.getAttribute("aria-label")).toBe("Cancel queued prompt");

    keydown(remove, "Enter");
    keydown(remove, " ");
    keydown(remove, "Tab");
    expect(cancelled).toBe(2);
  });
});
