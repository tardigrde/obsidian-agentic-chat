import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolApprovalRequest } from "../../src/agent/tool-call-controller";
import { ApprovalModal } from "../../src/ui/approval-modal";
import { fakeApp, seedFile, settle, type FakeApp } from "./support/mount-chat-view";

/** What the approval modal shows and how each control settles the decision. */

let modal: ApprovalModal | null = null;

afterEach(() => {
  modal?.close();
  modal = null;
});

function ask(app: FakeApp, request: Partial<ToolApprovalRequest> & { toolName: string; args: unknown }, onStop?: () => void) {
  modal = new ApprovalModal(app.app, { label: request.toolName, ...request } as ToolApprovalRequest, onStop);
  return modal.ask();
}

const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const $$ = (selector: string) => Array.from(document.querySelectorAll<HTMLElement>(selector));
const button = (label: string) => $$(".modal-container button").find((el) => el.textContent === label) as HTMLButtonElement | undefined;
const diffLines = () => $$(".agentic-chat-approval-diff-line").map((el) => `${el.className.replace("agentic-chat-approval-diff-line ", "")}|${el.textContent}`);

describe("ApprovalModal rendering", () => {
  it("previews an edit as an exact diff with a +/- stat and expandable context", async () => {
    const app = fakeApp();
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
    await seedFile(app, "Notes/long.md", lines.join("\n"));
    const decision = ask(app, { toolName: "edit", label: "Edit note", args: { path: "Notes/long.md", edits: [{ oldText: "line 15", newText: "line fifteen" }] } });
    await settle();

    expect($(".modal-title")?.textContent).toBe('Allow "Edit note"?');
    expect($$(".agentic-chat-approval-summary").map((el) => el.textContent)).toEqual(["Edit Notes/long.md", "+1 −1"]);
    expect(diffLines()).toContain("is-remove|- line 15");
    expect(diffLines()).toContain("is-add|+ line fifteen");
    const shownBefore = diffLines().length;
    const expand = $$(".agentic-chat-diff-expand").find((el) => el.textContent?.includes("above"));
    expect(expand?.textContent).toBe("Show 5 more lines above");
    expand?.click();
    expect(diffLines().length).toBe(shownBefore + 5);

    button("Allow")?.click();
    await expect(decision).resolves.toEqual({ approved: true, remember: false });
    expect($(".modal-container")).toBeNull();
  });

  it("previews a new file as Create with every line added", async () => {
    const app = fakeApp();
    void ask(app, { toolName: "write", args: { path: "Notes/new.md", content: "a\nb" } });
    await settle();
    expect($$(".agentic-chat-approval-summary").map((el) => el.textContent)).toEqual(["Create Notes/new.md", "+2 −0"]);
    expect(diffLines()).toEqual(["is-add|+ a", "is-add|+ b"]);
  });

  it("previews a delete as a trash move and a rename as from -> to", async () => {
    const app = fakeApp();
    await seedFile(app, "Notes/old.md", "bye");
    void ask(app, { toolName: "delete", args: { path: "Notes/old.md" } });
    await settle();
    expect($(".agentic-chat-approval-summary")?.textContent).toBe("Move Notes/old.md to trash");
    expect(diffLines()).toEqual(["is-remove|- bye"]);
    modal?.close();

    void ask(app, { toolName: "rename", args: { path: "Notes/old.md", newPath: "Archive/old.md" } });
    await settle();
    expect($(".agentic-chat-approval-summary")?.textContent).toBe("Rename Notes/old.md → Archive/old.md");
  });

  it("keeps the raw arguments when an edit no longer matches the file", async () => {
    const app = fakeApp();
    await seedFile(app, "Notes/a.md", "current text");
    void ask(app, { toolName: "edit", args: { path: "Notes/a.md", edits: [{ oldText: "gone", newText: "x" }] } });
    await settle();
    expect($(".agentic-chat-approval-args")?.textContent).toContain('"oldText": "gone"');
    expect($(".agentic-chat-diff-window")).toBeNull();
  });

  it("shows the full create_skill body, a persistence warning, and no remember toggle", async () => {
    const app = fakeApp();
    const body = `${"x".repeat(3_000)}\nTAIL MARKER`;
    void ask(app, { toolName: "create_skill", args: { name: "My Skill", description: "does things", body } });
    await settle();
    expect($(".agentic-chat-approval-warning")).not.toBeNull();
    expect($$(".agentic-chat-approval-summary").map((el) => el.textContent)).toEqual([
      'Create skill "my-skill" (from "My Skill") → .agentic-plugins/my-skill/skills/my-skill/SKILL.md',
      "Description: does things",
    ]);
    expect($(".agentic-chat-approval-skill-body pre")?.textContent).toContain("TAIL MARKER");
    expect($(".checkbox-container")).toBeNull();
    expect($(".agentic-chat-approval-note")?.textContent).toContain("cannot be remembered");
  });

  it("labels a background tab's request with its session", async () => {
    const app = fakeApp();
    void ask(app, { toolName: "write", label: "Write file", sessionLabel: "Tab 2 • Notes", args: { path: "a.md", content: "" } });
    expect($(".modal-title")?.textContent).toBe('[Tab 2 • Notes] Allow "Write file"?');
    expect($(".agentic-chat-approval-session")?.textContent).toBe("Session: Tab 2 • Notes");
  });
});

describe("ApprovalModal decisions", () => {
  it("remembers Allow when the toggle is on", async () => {
    const decision = ask(fakeApp(), { toolName: "write", args: { path: "a.md", content: "" } });
    $(".checkbox-container")?.click();
    button("Allow")?.click();
    await expect(decision).resolves.toEqual({ approved: true, remember: true });
  });

  it("Enter allows; Enter in an armed deny confirms the deny with the reason", async () => {
    const app = fakeApp();
    const allowed = ask(app, { toolName: "write", args: { path: "a.md", content: "" } });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await expect(allowed).resolves.toEqual({ approved: true, remember: false });

    const denied = ask(app, { toolName: "write", args: { path: "a.md", content: "" } });
    button("Deny")?.click();
    expect($(".modal-title")?.textContent).toBe('Deny "write"?');
    const reason = $<HTMLTextAreaElement>(".agentic-chat-deny-reason-input")!;
    reason.value = "not now";
    reason.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await expect(denied).resolves.toEqual({ approved: false, remember: false, reason: "not now" });
  });

  it("Escape in the reason field disarms the deny instead of closing", async () => {
    const decision = ask(fakeApp(), { toolName: "write", args: { path: "a.md", content: "" } });
    button("Deny")?.click();
    const reason = $<HTMLTextAreaElement>(".agentic-chat-deny-reason-input")!;
    reason.value = "draft";
    reason.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(button("Deny")).toBeDefined();
    expect(reason.value).toBe("");
    expect($(".agentic-chat-deny-reason")?.style.display).toBe("none");
    expect($(".modal-container")).not.toBeNull();
    button("Allow")?.click();
    await expect(decision).resolves.toEqual({ approved: true, remember: false });
  });

  it("closing the modal without a choice denies; Stop turn denies as stopped and calls onStop once", async () => {
    const app = fakeApp();
    const dismissed = ask(app, { toolName: "write", args: { path: "a.md", content: "" } });
    $<HTMLElement>(".modal-close-button")?.click();
    await expect(dismissed).resolves.toEqual({ approved: false, remember: false });

    const onStop = vi.fn();
    const stopped = ask(app, { toolName: "write", args: { path: "a.md", content: "" } }, onStop);
    button("Stop turn")?.click();
    await expect(stopped).resolves.toMatchObject({ approved: false, stopped: true });
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});
