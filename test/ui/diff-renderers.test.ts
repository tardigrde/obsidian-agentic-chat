import { describe, expect, it } from "vitest";
import { renderStepEditDiff } from "../../src/ui/assistant-markdown";
import { renderApprovalDiffLines } from "../../src/ui/approval-card";
import { renderQuickAskDiff } from "../../src/ui/quick-ask-modal";

function container(): HTMLElement {
  return document.createElement("div");
}

function classes(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll("*")).flatMap((el) => Array.from(el.classList));
}

describe("diff renderer class names", () => {
  it("step cards use only the step diff line class", () => {
    const root = container();
    renderStepEditDiff(root, [{ oldText: "old\nline", newText: "new" }]);

    expect(root.querySelectorAll(".agentic-chat-step-diff-line.is-del")).toHaveLength(2);
    expect(root.querySelectorAll(".agentic-chat-step-diff-line.is-add")).toHaveLength(1);
    expect(classes(root)).not.toContain("agentic-chat-approval-diff-line");
    expect(classes(root)).not.toContain("agentic-chat-quick-ask-diff-line");
  });

  it("the approval modal uses only the approval diff line class", () => {
    const root = container();
    renderApprovalDiffLines(root, [
      { op: "add", text: "new" },
      { op: "remove", text: "old" },
      { op: "context", text: "same" },
    ]);

    expect(root.querySelectorAll(".agentic-chat-approval-diff-line.is-add")).toHaveLength(1);
    expect(root.querySelectorAll(".agentic-chat-approval-diff-line.is-remove")).toHaveLength(1);
    expect(root.querySelectorAll(".agentic-chat-approval-diff-line.is-context")).toHaveLength(1);
    expect(classes(root)).not.toContain("agentic-chat-step-diff-line");
    expect(classes(root)).not.toContain("agentic-chat-quick-ask-diff-line");
  });

  it("Quick Ask uses only the quick ask diff line class", () => {
    const root = container();
    renderQuickAskDiff(root, "old\nsame", "new\nsame");

    expect(root.querySelectorAll(".agentic-chat-quick-ask-diff-line.is-add").length).toBeGreaterThan(0);
    expect(root.querySelectorAll(".agentic-chat-quick-ask-diff-line.is-remove").length).toBeGreaterThan(0);
    expect(root.querySelectorAll(".agentic-chat-quick-ask-diff-line.is-context").length).toBeGreaterThan(0);
    expect(classes(root)).not.toContain("agentic-chat-step-diff-line");
    expect(classes(root)).not.toContain("agentic-chat-approval-diff-line");
  });
});
