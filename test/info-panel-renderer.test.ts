import { describe, expect, it } from "vitest";
import {
  renderActionPanel,
  renderErrorPanel,
  renderInfoPanel,
  renderSummaryPanel,
} from "../src/ui/info-panel-renderer";

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly listeners: Record<string, Array<() => void>> = {};
  open = false;
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

  appendText(text: string): void {
    this.text += text;
  }

  addEventListener(type: string, listener: () => void): void {
    this.listeners[type] = [...(this.listeners[type] ?? []), listener];
  }

  click(): void {
    for (const listener of this.listeners.click ?? []) listener();
  }

  findByClass(cls: string): FakeElement | undefined {
    if (this.classes.has(cls)) return this;
    for (const child of this.children) {
      const found = child.findByClass(cls);
      if (found) return found;
    }
    return undefined;
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

describe("info panel renderer", () => {
  it("renders info rows with the shared transcript classes", () => {
    const parent = root();

    const panel = renderInfoPanel(parent, "Status", [["Mode", "Safe"], ["Model", "test"]]);

    expect(panel.className).toContain("agentic-chat-info");
    expect(panel.textContent).toContain("Status");
    expect(panel.textContent).toContain("Mode");
    expect(panel.textContent).toContain("— Safe");
    expect(panel.textContent).toContain("Model");
    expect(panel.textContent).toContain("— test");
  });

  it("renders action panels and wires row clicks", () => {
    const parent = root();
    let clicked = 0;

    const panel = renderActionPanel(parent, "Projects", "Pick one.", [
      { label: "Vault-wide", detail: "current", icon: "folder", onClick: () => clicked += 1 },
    ]);

    expect(panel.textContent).toContain("Projects");
    expect(panel.textContent).toContain("Pick one.");
    expect(panel.textContent).toContain("Vault-wide");
    fake(panel).findByClass("agentic-chat-action-row")?.click();
    expect(clicked).toBe(1);
  });

  it("renders summary panels from tagged or plain text", () => {
    const tagged = renderSummaryPanel(root(), "<conversation-summary>\nEarlier context.\n</conversation-summary>");
    const plain = renderSummaryPanel(root(), "Plain summary.");

    expect(tagged.textContent).toContain("Summarized earlier conversation");
    expect(tagged.textContent).toContain("Earlier context.");
    expect(plain.textContent).toContain("Plain summary.");
  });

  it("renders error panels with the error class", () => {
    const panel = renderErrorPanel(root(), "Something failed.");

    expect(panel.className).toContain("agentic-chat-info-error");
    expect(panel.textContent).toContain("Error");
    expect(panel.textContent).toContain("Something failed.");
  });
});
