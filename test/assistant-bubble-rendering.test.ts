import { afterEach, describe, expect, it } from "vitest";
import { classifyRenderedChatLink, enhanceCallouts, renderMermaidBlocks } from "../src/ui/assistant-bubble";

class FakeClassList {
  private readonly values = new Set<string>();

  constructor(initial = "") {
    for (const value of initial.split(/\s+/)) {
      if (value) this.values.add(value);
    }
  }

  add(...values: string[]): void {
    for (const value of values) this.values.add(value);
  }

  contains(value: string): boolean {
    return this.values.has(value);
  }

  toString(): string {
    return [...this.values].join(" ");
  }
}

class FakeElement {
  readonly tagName: string;
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly attributes: Record<string, string> = {};
  readonly classList = new FakeClassList();
  parentElement: FakeElement | null = null;
  innerHTML = "";
  private text = "";

  constructor(tagName: string, text = "") {
    this.tagName = tagName.toUpperCase();
    this.text = text;
  }

  get className(): string {
    return this.classList.toString();
  }

  set className(value: string) {
    this.classList.add(...value.split(/\s+/).filter(Boolean));
  }

  get localName(): string {
    return this.tagName.toLowerCase();
  }

  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.text = value;
    this.children.splice(0);
  }

  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  createDiv(options?: { cls?: string | string[]; text?: string }): FakeElement {
    const child = new FakeElement("div", options?.text ?? "");
    const classes = Array.isArray(options?.cls) ? options.cls : options?.cls ? [options.cls] : [];
    child.classList.add(...classes);
    this.appendChild(child);
    return child;
  }

  appendChild(child: FakeElement): FakeElement {
    child.remove();
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  remove(): void {
    const parent = this.parentElement;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    if (index >= 0) parent.children.splice(index, 1);
    this.parentElement = null;
  }

  replaceWith(next: FakeElement): void {
    const parent = this.parentElement;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    if (index >= 0) parent.children[index] = next;
    next.parentElement = parent;
    this.parentElement = null;
  }

  replaceChildren(...nodes: FakeElement[]): void {
    for (const child of this.children.splice(0)) child.parentElement = null;
    for (const node of nodes) this.appendChild(node);
  }

  importNode<T>(node: T, _deep?: boolean): T {
    return node;
  }

  closest(selector: string): FakeElement | null {
    if (!selector.startsWith(".")) return null;
    const cls = selector.slice(1);
    if (this.classList.contains(cls)) return this;
    let current = this.parentElement;
    while (current) {
      if (current.classList.contains(cls)) return current;
      current = current.parentElement;
    }
    return null;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const all = [...this.walk()];
    if (selector === "blockquote") return all.filter((el) => el.tagName === "BLOCKQUOTE");
    if (selector === "parsererror") return all.filter((el) => el.tagName === "PARSERERROR");
    if (selector === "pre > code.language-mermaid") {
      return all.filter(
        (el) =>
          el.tagName === "CODE" &&
          el.classList.contains("language-mermaid") &&
          el.parentElement?.tagName === "PRE",
      );
    }
    return [];
  }

  addClass(value: string): void {
    this.classList.add(value);
  }

  setAttr(name: string, value: string): void {
    this.attributes[name] = value;
  }

  private *walk(): Generator<FakeElement> {
    for (const child of this.children) {
      yield child;
      yield* child.walk();
    }
  }
}

function el(tagName: string, text = ""): FakeElement {
  return new FakeElement(tagName, text);
}

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { activeDocument?: unknown }).activeDocument;
  delete (globalThis as { DOMParser?: unknown }).DOMParser;
  delete (globalThis as { __obsidianMockMermaid?: unknown }).__obsidianMockMermaid;
});

describe("assistant markdown rendering helpers", () => {
  it("classifies rendered vault and external links", () => {
    expect(classifyRenderedChatLink(anchor({ "data-href": "Notes/Plan.md" }))).toEqual({
      kind: "vault",
      target: "Notes/Plan.md",
    });
    expect(classifyRenderedChatLink(anchor({ href: "Notes/Plan%20A.md" }))).toEqual({
      kind: "vault",
      target: "Notes/Plan A.md",
    });
    expect(classifyRenderedChatLink(anchor({ href: "https://example.com/path" }))).toEqual({
      kind: "external",
      target: "https://example.com/path",
    });
    expect(classifyRenderedChatLink(anchor({ href: "external://src/app.ts" }))).toEqual({
      kind: "external",
      target: "external://src/app.ts",
    });
    expect(classifyRenderedChatLink(anchor({ href: "artifact:artifact-1" }))).toBeNull();
    expect(classifyRenderedChatLink(anchor({ href: "#local-heading" }))).toBeNull();
  });

  it("converts Obsidian callout blockquotes when MarkdownRenderer leaves them plain", () => {
    const root = el("div");
    const blockquote = el("blockquote");
    blockquote.appendChild(el("p", "[!warning] Check this"));
    blockquote.appendChild(el("p", "Body"));
    root.appendChild(blockquote);
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { createElement: (tagName: string) => el(tagName) },
    });
    Object.defineProperty(globalThis, "activeDocument", {
      configurable: true,
      value: {
        createElement: (tagName: string) => el(tagName),
        importNode: <T>(node: T) => node,
      },
    });

    enhanceCallouts(root as unknown as HTMLElement);

    const callout = root.children[0];
    expect(callout.classList.contains("callout")).toBe(true);
    expect(callout.dataset.callout).toBe("warning");
    expect(callout.children[0].children[1].textContent).toBe("Check this");
    expect(callout.children[1].textContent).toBe("Body");
  });

  it("replaces Mermaid code blocks with rendered SVG containers", async () => {
    const root = el("div");
    const pre = el("pre");
    const code = el("code", "graph TD; A-->B");
    code.classList.add("language-mermaid");
    pre.appendChild(code);
    root.appendChild(pre);
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { createElement: (tagName: string) => el(tagName) },
    });
    Object.defineProperty(globalThis, "activeDocument", {
      configurable: true,
      value: {
        createElement: (tagName: string) => el(tagName),
        importNode: <T>(node: T) => node,
      },
    });
    Object.defineProperty(globalThis, "DOMParser", {
      configurable: true,
      value: class {
        parseFromString(markup: string): { documentElement: FakeElement } {
          const documentElement = el("svg");
          // Real DOMParser(image/svg+xml) makes <svg> the document element; its
          // serialized content is only the markup inside the root tag.
          const match = /^<svg\b[^>]*>([\s\S]*)<\/svg>\s*$/i.exec(markup.trim());
          documentElement.innerHTML = match?.[1] ?? markup;
          return { documentElement };
        }
      },
    });
    (globalThis as { __obsidianMockMermaid?: unknown }).__obsidianMockMermaid = {
      render: async (_id: string, source: string) => ({ svg: `<svg>${source}</svg>` }),
    };

    await renderMermaidBlocks(root as unknown as HTMLElement);

    expect(root.children[0].classList.contains("agentic-chat-mermaid")).toBe(true);
    const svg = root.children[0].children[0];
    expect(svg.tagName).toBe("SVG");
    expect(svg.innerHTML).toBe("graph TD; A-->B");
  });

  it("flags Mermaid blocks as errors when the rendered SVG is invalid", async () => {
    const root = el("div");
    const pre = el("pre");
    const code = el("code", "graph TD; A-->B");
    code.classList.add("language-mermaid");
    pre.appendChild(code);
    root.appendChild(pre);
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { createElement: (tagName: string) => el(tagName) },
    });
    Object.defineProperty(globalThis, "activeDocument", {
      configurable: true,
      value: {
        createElement: (tagName: string) => el(tagName),
        importNode: <T>(node: T) => node,
      },
    });
    Object.defineProperty(globalThis, "DOMParser", {
      configurable: true,
      value: class {
        parseFromString(_markup: string): { documentElement: FakeElement } {
          // Simulate a DOMParser parse failure: root is <parsererror>, not <svg>.
          return { documentElement: el("parsererror") };
        }
      },
    });
    (globalThis as { __obsidianMockMermaid?: unknown }).__obsidianMockMermaid = {
      render: async () => ({ svg: "<parsererror>boom</parsererror>" }),
    };

    await renderMermaidBlocks(root as unknown as HTMLElement);

    expect(root.children[0].classList.contains("agentic-chat-mermaid-error")).toBe(true);
  });
});

function anchor(attrs: Record<string, string>): { getAttribute: (name: string) => string | null } {
  return {
    getAttribute: (name: string) => attrs[name] ?? null,
  };
}
