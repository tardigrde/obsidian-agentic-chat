import { describe, expect, it } from "vitest";
import type { RelevantNotesPanelState } from "../src/retrieval/relevant-notes";
import { renderPlanTrackerPanel, planTrackerStatusIcon } from "../src/ui/plan-tracker-renderer";
import type { PlanTrackerPanelState } from "../src/ui/plan-tracker-panel";
import { relevantNoteFileName, relevantNotesEmptyText, renderRelevantNotesPanel } from "../src/ui/relevant-notes-renderer";

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly listeners: Record<string, Array<() => void>> = {};
  hidden = false;
  private text = "";
  private readonly classes = new Set<string>();

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

  createEl(tag: string, options?: { cls?: string | string[]; text?: string; attr?: Record<string, string> }): FakeElement {
    return this.createChild(tag, options);
  }

  empty(): void {
    this.children.splice(0);
    this.text = "";
  }

  hide(): void {
    this.hidden = true;
  }

  show(): void {
    this.hidden = false;
  }

  addEventListener(type: string, listener: () => void): void {
    this.listeners[type] = [...(this.listeners[type] ?? []), listener];
  }

  click(): void {
    for (const listener of this.listeners.click ?? []) listener();
  }

  findByClass(cls: string): FakeElement | undefined {
    return this.findAllByClass(cls)[0];
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
    this.children.push(child);
    return child;
  }
}

function root(): HTMLElement {
  return new FakeElement("root") as unknown as HTMLElement;
}

function fake(el: HTMLElement): FakeElement {
  return el as unknown as FakeElement;
}

describe("side panel renderers", () => {
  it("renders and hides relevant notes panel states", () => {
    const parent = fake(root());
    renderRelevantNotesPanel(parent as unknown as HTMLElement, { activePath: null, suggestions: [], ignoredCount: 0, emptyReason: "no-active-note" }, {
      attach: () => {},
      togglePin: () => {},
      exclude: () => {},
    });
    expect(parent.hidden).toBe(true);

    renderRelevantNotesPanel(parent as unknown as HTMLElement, {
      activePath: "Notes/Active.md",
      suggestions: [],
      ignoredCount: 0,
      emptyReason: "no-related-notes",
    }, {
      attach: () => {},
      togglePin: () => {},
      exclude: () => {},
    });
    expect(parent.hidden).toBe(false);
    expect(parent.textContent).toContain("Related: 0");
    expect(parent.textContent).toContain("No related notes found.");
  });

  it("renders related notes as a compact filename summary", () => {
    const parent = fake(root());
    const state: RelevantNotesPanelState = {
      activePath: "Notes/Active.md",
      ignoredCount: 0,
      emptyReason: null,
      suggestions: [
        { path: "Notes/First.md", title: "Different title", score: 1, snippets: [], why: [], pinned: false },
        { path: "Notes/Second.md", title: "Second heading", score: 0.9, snippets: [], why: [], pinned: false },
        { path: "Notes/Third.md", title: "Third heading", score: 0.8, snippets: [], why: [], pinned: false },
        { path: "Notes/Fourth.md", title: "Fourth heading", score: 0.7, snippets: [], why: [], pinned: false },
      ],
    };

    renderRelevantNotesPanel(parent as unknown as HTMLElement, state, {
      attach: () => {},
      togglePin: () => {},
      exclude: () => {},
    });

    const summary = parent.findByClass("agentic-chat-relevant-summary");
    expect(summary?.textContent).toContain("Related: 4");
    expect(summary?.textContent).toContain("First.md");
    expect(summary?.textContent).toContain("Second.md");
    expect(summary?.textContent).toContain("+2");
    expect(summary?.textContent).not.toContain("Third.md");
    expect(parent.textContent).not.toContain("Different title");
  });

  it("wires relevant-note attach, pin, and exclude actions", () => {
    const parent = fake(root());
    const events: string[] = [];
    const state: RelevantNotesPanelState = {
      activePath: "Notes/Active.md",
      ignoredCount: 0,
      emptyReason: null,
      suggestions: [
        {
          path: "Notes/Next.md",
          title: "Next note",
          score: 1,
          snippets: [],
          why: ["shared tag"],
          pinned: false,
        },
      ],
    };

    renderRelevantNotesPanel(parent as unknown as HTMLElement, state, {
      attach: (path) => events.push(`attach:${path}`),
      togglePin: (path, pinned) => events.push(`pin:${path}:${pinned}`),
      exclude: (path) => events.push(`exclude:${path}`),
    });

    expect(parent.textContent).toContain("Next.md");
    expect(parent.textContent).not.toContain("Next note");
    parent.findByClass("agentic-chat-relevant-main")?.click();
    const iconButtons = parent.findAllByClass("clickable-icon");
    iconButtons[0]?.click();
    iconButtons[1]?.click();
    expect(events).toEqual(["attach:Notes/Next.md", "pin:Notes/Next.md:false", "exclude:Notes/Next.md"]);
  });

  it("renders plan tracker panel states", () => {
    const parent = fake(root());
    renderPlanTrackerPanel(parent as unknown as HTMLElement, { visible: false, title: "", summary: "", items: [] });
    expect(parent.hidden).toBe(true);

    const state: PlanTrackerPanelState = {
      visible: true,
      title: "Plan",
      summary: "1 active",
      items: [
        {
          id: "1",
          title: "Refactor panel",
          status: "in_progress",
          statusLabel: "in progress",
          testStatus: "passed",
          testLabel: "tests passed",
          checkpointCommit: "abc1234",
          note: "kept small",
        },
      ],
    };
    renderPlanTrackerPanel(parent as unknown as HTMLElement, state);

    expect(parent.hidden).toBe(false);
    expect(parent.textContent).toContain("Plan");
    expect(parent.textContent).toContain("1. Refactor panel");
    expect(parent.textContent).toContain("tests passed");
    expect(parent.textContent).toContain("commit abc1234");
    expect(parent.findByClass("is-in_progress")).toBeDefined();
  });

  it("keeps side-panel labels stable", () => {
    expect(relevantNotesEmptyText("active-note-ignored")).toBe("Active note is ignored.");
    expect(relevantNotesEmptyText("active-note-missing")).toBe("Active note is not loaded.");
    expect(relevantNotesEmptyText("no-related-notes")).toBe("No related notes found.");
    expect(relevantNotesEmptyText(null)).toBe("Open a note to see related notes.");
    expect(relevantNoteFileName("Projects/Alpha/Related.md")).toBe("Related.md");
    expect(planTrackerStatusIcon("done")).toBe("check-circle-2");
    expect(planTrackerStatusIcon("in_progress")).toBe("play-circle");
    expect(planTrackerStatusIcon("blocked")).toBe("octagon-alert");
    expect(planTrackerStatusIcon("pending")).toBe("circle");
  });
});
