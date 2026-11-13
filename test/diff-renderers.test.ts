import { describe, expect, it } from "vitest";
import { renderStepEditDiff } from "../src/ui/assistant-markdown";
import { renderApprovalDiffLines } from "../src/ui/approval-modal";
import { renderQuickAskDiff } from "../src/ui/quick-ask-modal";
import { fakeElement, type FakeElement } from "./helpers/fake-dom";

function container(): HTMLElement {
  return fakeElement() as unknown as HTMLElement;
}

function classes(root: FakeElement): string[] {
  return root.querySelectorAll("*").flatMap((el) => el.className.split(/\s+/).filter(Boolean));
}

describe("diff renderer class names", () => {
  it("step cards use only the step diff line class", () => {
    const root = container() as unknown as FakeElement;
    renderStepEditDiff(root as unknown as HTMLElement, [{ oldText: "old\nline", newText: "new" }]);

    expect(root.querySelectorAll(".agentic-chat-step-diff-line.is-del")).toHaveLength(2);
    expect(root.querySelectorAll(".agentic-chat-step-diff-line.is-add")).toHaveLength(1);
    expect(classes(root)).not.toContain("agentic-chat-approval-diff-line");
    expect(classes(root)).not.toContain("agentic-chat-quick-ask-diff-line");
  });

  it("the approval modal uses only the approval diff line class", () => {
    const root = container() as unknown as FakeElement;
    renderApprovalDiffLines(root as unknown as HTMLElement, [
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
    const root = container() as unknown as FakeElement;
    renderQuickAskDiff(root as unknown as HTMLElement, "old\nsame", "new\nsame");

    expect(root.querySelectorAll(".agentic-chat-quick-ask-diff-line.is-add").length).toBeGreaterThan(0);
    expect(root.querySelectorAll(".agentic-chat-quick-ask-diff-line.is-remove").length).toBeGreaterThan(0);
    expect(root.querySelectorAll(".agentic-chat-quick-ask-diff-line.is-context").length).toBeGreaterThan(0);
    expect(classes(root)).not.toContain("agentic-chat-step-diff-line");
    expect(classes(root)).not.toContain("agentic-chat-approval-diff-line");
  });
});
