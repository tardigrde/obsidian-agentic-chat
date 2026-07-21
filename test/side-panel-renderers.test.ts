import { describe, expect, it } from "vitest";
import { renderPlanTrackerPanel, planTrackerStatusIcon } from "../src/ui/plan-tracker-renderer";
import type { PlanTrackerPanelState } from "../src/ui/plan-tracker-panel";

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
    expect(planTrackerStatusIcon("done")).toBe("check-circle-2");
    expect(planTrackerStatusIcon("in_progress")).toBe("play-circle");
    expect(planTrackerStatusIcon("blocked")).toBe("octagon-alert");
    expect(planTrackerStatusIcon("pending")).toBe("circle");
  });
});
