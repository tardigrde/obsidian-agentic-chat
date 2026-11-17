import { afterEach, describe, expect, it } from "vitest";
import { subagentResultForcesError } from "../../src/ui/subagent-tree";
import {
  classifyRenderedChatLink,
  enhanceCallouts,
  renderMermaidBlocks,
  sourceChipName,
} from "../../src/ui/assistant-markdown";

function el(tagName: string, text = ""): HTMLElement {
  const node = document.createElement(tagName);
  if (text) node.textContent = text;
  return node;
}

afterEach(() => {
  delete (globalThis as { __obsidianMockMermaid?: unknown }).__obsidianMockMermaid;
});

describe("assistant markdown rendering helpers", () => {
  it("derives a compact source-chip name from a vault path", () => {
    expect(sourceChipName("Notes/Plan.md")).toBe("Plan.md");
    expect(sourceChipName("Projects/Alpha/Home.md")).toBe("Home.md");
    expect(sourceChipName("readme")).toBe("readme");
    expect(sourceChipName("")).toBe("");
    expect(sourceChipName("   ")).toBe("");
    expect(sourceChipName("dir/")).toBe("dir");
  });

  it("forces the stopped-dispatch verdict from live results and wrapped replay details", () => {
    const aborted = { agent: "explorer", task: "hang", status: "aborted", summary: "Stopped by user" };
    const done = { agent: "explorer", task: "work", status: "done", summary: "ok" };
    // Live path: endStep receives the full tool result object.
    const liveResult = { content: [{ type: "text", text: "stopped" }], details: { kind: "subagent", children: [aborted] } };
    expect(subagentResultForcesError(liveResult)).toBe(true);
    // Replay path: chat-view wraps the persisted details as `{ details }`.
    const replayShape = { details: { kind: "subagent", children: [aborted] } };
    expect(subagentResultForcesError(replayShape)).toBe(true);
    // A clean child (or no statuses at all) never forces red.
    expect(subagentResultForcesError({ details: { kind: "subagent", children: [done] } })).toBe(false);
    expect(subagentResultForcesError(undefined)).toBe(false);
    expect(subagentResultForcesError({})).toBe(false);
  });

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
    expect(classifyRenderedChatLink(anchor({ href: "external://src/app.ts" }))).toBeNull();
    expect(classifyRenderedChatLink(anchor({ href: "artifact:artifact-1" }))).toBeNull();
    expect(classifyRenderedChatLink(anchor({ href: "#local-heading" }))).toBeNull();
  });

  it("converts Obsidian callout blockquotes when MarkdownRenderer leaves them plain", () => {
    const root = el("div");
    const blockquote = el("blockquote");
    blockquote.appendChild(el("p", "[!warning] Check this"));
    blockquote.appendChild(el("p", "Body"));
    root.appendChild(blockquote);

    enhanceCallouts(root);

    const callout = root.children[0];
    expect(callout.classList.contains("callout")).toBe(true);
    expect((callout as HTMLElement).dataset.callout).toBe("warning");
    expect(callout.children[0].children[1].textContent).toBe("Check this");
    expect(callout.children[1].textContent).toBe("Body");
  });

  it("replaces Mermaid code blocks with rendered SVG containers", async () => {
    const root = el("div");
    const pre = el("pre");
    const code = el("code", "graph TD; A---B");
    code.classList.add("language-mermaid");
    pre.appendChild(code);
    root.appendChild(pre);
    (globalThis as { __obsidianMockMermaid?: unknown }).__obsidianMockMermaid = {
      render: async (_id: string, source: string) => ({ svg: `<svg><text>${source}</text></svg>` }),
    };

    await renderMermaidBlocks(root);

    expect(root.children[0].classList.contains("agentic-chat-mermaid")).toBe(true);
    const svg = root.children[0].children[0];
    expect(svg.tagName.toLowerCase()).toBe("svg");
    expect(svg.textContent).toBe("graph TD; A---B");
    expect(root.querySelector("pre")).toBeNull();
  });

  it("flags Mermaid blocks as errors when the rendered SVG is invalid", async () => {
    const root = el("div");
    const pre = el("pre");
    const code = el("code", "graph TD; A-->B");
    code.classList.add("language-mermaid");
    pre.appendChild(code);
    root.appendChild(pre);
    (globalThis as { __obsidianMockMermaid?: unknown }).__obsidianMockMermaid = {
      render: async () => ({ svg: "<parsererror>boom</parsererror>" }),
    };

    await renderMermaidBlocks(root);

    expect(root.children[0].classList.contains("agentic-chat-mermaid-error")).toBe(true);
  });
});

function anchor(attrs: Record<string, string>): { getAttribute: (name: string) => string | null; dataset: Record<string, string> } {
  const dataset: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith("data-")) {
      dataset[key.slice(5)] = value;
    }
  }
  return {
    getAttribute: (name: string) => attrs[name] ?? null,
    dataset,
  };
}
