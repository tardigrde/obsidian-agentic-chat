import { describe, expect, it } from "vitest";
import { FOLDER_PREFIX } from "../src/ui/autocomplete";
import type { ContextAttachment } from "../src/ui/context-attachments";
import { renderContextChips } from "../src/ui/context-chip-renderer";

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly listeners: Record<string, Array<() => void>> = {};
  private text = "";
  private readonly classes = new Set<string>();
  private readonly attrs = new Map<string, string>();

  constructor(readonly tagName: string) {}

  get className(): string {
    return [...this.classes].join(" ");
  }

  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join("");
  }

  createDiv(options?: { cls?: string | string[]; text?: string; attr?: Record<string, string> }): FakeElement {
    return this.createChild("div", options);
  }

  createSpan(options?: { cls?: string | string[]; text?: string; attr?: Record<string, string> }): FakeElement {
    return this.createChild("span", options);
  }

  empty(): void {
    this.children.splice(0);
    this.text = "";
  }

  setAttr(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  attr(name: string): string | undefined {
    return this.attrs.get(name);
  }

  addEventListener(type: string, listener: () => void): void {
    this.listeners[type] = [...(this.listeners[type] ?? []), listener];
  }

  click(): void {
    for (const listener of this.listeners.click ?? []) listener();
  }

  findAllByClass(cls: string): FakeElement[] {
    const matches: FakeElement[] = this.classes.has(cls) ? [this] : [];
    for (const child of this.children) matches.push(...child.findAllByClass(cls));
    return matches;
  }

  private createChild(
    tag: string,
    options?: { cls?: string | string[]; text?: string; attr?: Record<string, string> },
  ): FakeElement {
    const child = new FakeElement(tag);
    child.text = options?.text ?? "";
    const classes = Array.isArray(options?.cls) ? options.cls : options?.cls ? [options.cls] : [];
    for (const cls of classes) child.classes.add(cls);
    for (const [name, value] of Object.entries(options?.attr ?? {})) child.setAttr(name, value);
    this.children.push(child);
    return child;
  }
}

function root(): FakeElement {
  return new FakeElement("root");
}

function chipTextParts(chip: FakeElement): string[] {
  return chip.children.map((child) => child.textContent).filter(Boolean);
}

describe("context chip renderer", () => {
  it("renders working dirs, active note, and explicit attachments in a stable order", () => {
    const parent = root();
    const selection: ContextAttachment = {
      type: "text",
      id: "selection:1",
      label: "Selection",
      text: "Selected text",
    };

    renderContextChips(parent as unknown as HTMLElement, {
      workingDirs: ["Notes", ""],
      activeNotePath: "Daily.md",
      attachments: [`${FOLDER_PREFIX}Projects`, "Images/photo.png", selection],
    }, {
      removeWorkingDir: () => {},
      removeActiveNote: () => {},
      removeAttachment: () => {},
    });

    const chips = parent.findAllByClass("agentic-chat-chip");
    expect(chips.map(chipTextParts)).toEqual([
      ["Notes", "scope"],
      ["/ (vault root)", "scope"],
      ["Daily.md", "active"],
      ["Projects"],
      ["Images/photo.png"],
      ["Selection"],
    ]);
    expect(chips[0].className).toContain("is-scope");
    expect(chips[2].className).toContain("is-active-note");
    expect(chips[2].attr("title")).toBe("The active note is attached automatically — remove to stop for this session.");
    expect(chips[0].attr("title")).toBe(
      "Working directory — the agent auto-runs inside it and asks before touching anything outside. Remove to revoke.",
    );
  });

  it("wires remove callbacks to the matching chip", () => {
    const parent = root();
    const events: string[] = [];
    const attachment = `${FOLDER_PREFIX}Projects`;

    renderContextChips(parent as unknown as HTMLElement, {
      workingDirs: ["Notes"],
      activeNotePath: "Daily.md",
      attachments: [attachment],
    }, {
      removeWorkingDir: (dir) => events.push(`dir:${dir}`),
      removeActiveNote: () => events.push("active"),
      removeAttachment: (entry) => events.push(`attachment:${entry}`),
    });

    for (const remove of parent.findAllByClass("agentic-chat-chip-remove")) remove.click();

    expect(events).toEqual(["dir:Notes", "active", `attachment:${attachment}`]);
  });
});
