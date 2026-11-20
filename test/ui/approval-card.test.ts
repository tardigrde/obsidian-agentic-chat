import { afterEach, describe, expect, it } from "vitest";
import type { ToolApprovalRequest } from "../../src/agent/tool-call-controller";
import { STOPPED_APPROVAL_REASON } from "../../src/agent/tool-call-controller";
import { ApprovalCard } from "../../src/ui/approval-card";
import { fakeApp, seedFile, settle, type FakeApp } from "./support/mount-chat-view";

/** What the inline approval card shows and how each control settles the decision. */

let card: ApprovalCard | null = null;

afterEach(() => {
  card?.stop();
  card?.el.remove();
  card = null;
});

function ask(
  app: FakeApp,
  request: Partial<ToolApprovalRequest> & { toolName: string; args: unknown },
  signal?: AbortSignal,
): ApprovalCard {
  card = new ApprovalCard({ app: app.app, request: { label: request.toolName, ...request } as ToolApprovalRequest, signal });
  document.body.appendChild(card.el);
  return card;
}

const $ = <T extends Element = HTMLElement>(selector: string) => card?.el.querySelector<T>(selector) ?? null;
const $$ = (selector: string) => Array.from(card?.el.querySelectorAll<HTMLElement>(selector) ?? []);
const button = (label: string) => $$("button").find((el) => el.textContent === label) as HTMLButtonElement | undefined;
const diffLines = () =>
  $$(".agentic-chat-approval-diff-line").map((el) => `${el.className.replace("agentic-chat-approval-diff-line ", "")}|${el.textContent}`);
const key = (target: HTMLElement, value: string) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));

describe("ApprovalCard rendering", () => {
  it("previews an edit as an exact diff with a +/- stat and expandable context; Allow settles once", async () => {
    const app = fakeApp();
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
    await seedFile(app, "Notes/long.md", lines.join("\n"));
    const c = ask(app, { toolName: "edit", label: "Edit note", args: { path: "Notes/long.md", edits: [{ oldText: "line 15", newText: "line fifteen" }] } });
    await settle();

    // Compact, as in the design: the head names the action and path, one stat line, no generic description.
    expect($(".agentic-chat-approval-title")?.textContent).toBe("Edit Notes/long.md");
    expect($$(".agentic-chat-approval-summary").map((el) => el.textContent)).toEqual(["+1 −1"]);
    expect($(".agentic-chat-approval-desc")).toBeNull();
    expect(diffLines()).toContain("is-remove|- line 15");
    expect(diffLines()).toContain("is-add|+ line fifteen");
    const shownBefore = diffLines().length;
    const expand = $$(".agentic-chat-diff-expand").find((el) => el.textContent?.includes("above"));
    expect(expand?.textContent).toBe("Show 5 more lines above");
    expand?.click();
    expect(diffLines().length).toBe(shownBefore + 5);

    button("Allow")?.click();
    await expect(c.choice).resolves.toEqual({ approved: true, remember: false });
    // Resolved: one muted line that stays as a record.
    expect(c.el.classList.contains("is-resolved")).toBe(true);
    expect($(".agentic-chat-approval-outcome")?.textContent).toBe("Allowed once");
    expect($(".agentic-chat-diff-window")).toBeNull();
    button("Deny")?.click();
    expect(c.outcome).toBe("allowed");
  });

  it("previews a new file as Create with every line added", async () => {
    const app = fakeApp();
    ask(app, { toolName: "write", args: { path: "Notes/new.md", content: "a\nb" } });
    await settle();
    expect($(".agentic-chat-approval-title")?.textContent).toBe("Create Notes/new.md");
    expect($$(".agentic-chat-approval-summary").map((el) => el.textContent)).toEqual(["+2 −0"]);
    expect(diffLines()).toEqual(["is-add|+ a", "is-add|+ b"]);
  });

  it("previews a delete as a trash move and a rename as from -> to", async () => {
    const app = fakeApp();
    await seedFile(app, "Notes/old.md", "bye");
    ask(app, { toolName: "delete", args: { path: "Notes/old.md" } });
    await settle();
    expect($(".agentic-chat-approval-title")?.textContent).toBe("Move Notes/old.md to trash");
    expect(diffLines()).toEqual(["is-remove|- bye"]);
    card?.stop();

    ask(app, { toolName: "rename", args: { path: "Notes/old.md", newPath: "Archive/old.md" } });
    await settle();
    expect($(".agentic-chat-approval-title")?.textContent).toBe("Rename Notes/old.md → Archive/old.md");
  });

  it("the head puts the path in its own accent span and wraps instead of cutting it", async () => {
    const app = fakeApp();
    const path = "Meetings/2026/11/Weekly sync notes with a very long name.md";
    ask(app, { toolName: "write", args: { path, content: "a" } });
    await settle();
    expect($(".agentic-chat-approval-title .agentic-chat-approval-path")?.textContent).toBe(path);
    expect($(".agentic-chat-approval-title")?.getAttribute("title")).toBe(`Create ${path}`);
  });

  it("an exact edit names the section it changes, from the nearest heading above", async () => {
    const app = fakeApp();
    await seedFile(app, "Notes/plan.md", "# Plan\n\nIntro\n\n## Next steps\n\nTBD\n");
    ask(app, { toolName: "edit", args: { path: "Notes/plan.md", edits: [{ oldText: "TBD", newText: "- [ ] Draft scope" }] } });
    await settle();
    expect($$(".agentic-chat-approval-summary").map((el) => el.textContent)).toEqual(['+1 −1 · in "Next steps"']);
  });

  it("Show more stops (and its buttons go) once the window is too large to diff", async () => {
    const app = fakeApp();
    const head = Array.from({ length: 100 }, (_, index) => `head ${index}`).join("\n");
    const oldText = Array.from({ length: 490 }, (_, index) => `old ${index}`).join("\n");
    const newText = Array.from({ length: 490 }, (_, index) => `new ${index}`).join("\n");
    await seedFile(app, "Notes/wide.md", `${head}\n${oldText}`);
    ask(app, { toolName: "edit", args: { path: "Notes/wide.md", edits: [{ oldText, newText }] } });
    await settle();
    const above = () => $$(".agentic-chat-diff-expand") as HTMLButtonElement[];
    expect(above().length).toBeGreaterThan(0);
    // Each click grows the window by 5 lines; soon a diff of it is too large.
    for (let clicks = 0; clicks < 20 && above().length > 0; clicks += 1) {
      above()[0]?.click();
      await settle();
    }
    // The window hit the diff limit: no dead "Show more" is left.
    expect(above()).toHaveLength(0);
    expect(diffLines().length).toBeGreaterThan(0);
  });

  it("an exact edit over a huge region shows the large-change summary instead of throwing", async () => {
    const app = fakeApp();
    const oldText = Array.from({ length: 600 }, (_, index) => `old ${index}`).join("\n");
    const newText = Array.from({ length: 600 }, (_, index) => `new ${index}`).join("\n");
    await seedFile(app, "Notes/big.md", oldText);
    ask(app, { toolName: "edit", args: { path: "Notes/big.md", edits: [{ oldText, newText }] } });
    await settle();
    expect($(".agentic-chat-approval-title")?.textContent).toBe("Edit Notes/big.md");
    expect($$(".agentic-chat-approval-summary").map((el) => el.textContent)).toEqual(["Large change: 600 → 600 lines (diff omitted)."]);
  });

  it("keeps the raw arguments when an edit no longer matches the file", async () => {
    const app = fakeApp();
    await seedFile(app, "Notes/a.md", "current text");
    ask(app, { toolName: "edit", args: { path: "Notes/a.md", edits: [{ oldText: "gone", newText: "x" }] } });
    await settle();
    // No concrete preview: the generic description stays, so the user knows what the tool does.
    expect($(".agentic-chat-approval-desc")).not.toBeNull();
    expect($(".agentic-chat-approval-args")?.textContent).toContain('"oldText": "gone"');
    expect($(".agentic-chat-diff-window")).toBeNull();
  });

  it("shows the full create_skill body, a persistence warning, and no Always button", async () => {
    const app = fakeApp();
    const body = `${"x".repeat(3_000)}\nTAIL MARKER`;
    ask(app, { toolName: "create_skill", args: { name: "My Skill", description: "does things", body } });
    await settle();
    expect($(".agentic-chat-approval-warning")).not.toBeNull();
    expect($$(".agentic-chat-approval-summary").map((el) => el.textContent)).toEqual([
      'Create skill "my-skill" (from "My Skill") → .agentic-plugins/my-skill/skills/my-skill/SKILL.md',
      "Description: does things",
    ]);
    expect($(".agentic-chat-approval-skill-body pre")?.textContent).toContain("TAIL MARKER");
    expect($('[data-ac="approval-always"]')).toBeNull();
    expect($(".agentic-chat-approval-note")?.textContent).toContain("cannot be remembered");
  });
});

describe("ApprovalCard decisions", () => {
  it("Always allow remembers the choice for the tool", async () => {
    const c = ask(fakeApp(), { toolName: "write", args: { path: "a.md", content: "" } });
    button("Always allow write")?.click();
    await expect(c.choice).resolves.toEqual({ approved: true, remember: true });
    expect($(".agentic-chat-approval-outcome")?.textContent).toBe("Allowed: always for write");
  });

  it("Enter allows; Esc arms the deny, and Enter in the reason confirms it with the reason", async () => {
    const allowed = ask(fakeApp(), { toolName: "write", args: { path: "a.md", content: "" } });
    key(allowed.el, "Enter");
    await expect(allowed.choice).resolves.toEqual({ approved: true, remember: false });

    const denied = ask(fakeApp(), { toolName: "write", args: { path: "a.md", content: "" } });
    key(denied.el, "Escape");
    expect(denied.phase).toBe("deny-armed");
    expect(button("Confirm deny")).toBeDefined();
    const reason = $<HTMLTextAreaElement>(".agentic-chat-deny-reason-input");
    reason!.value = "wrong folder";
    key(reason!, "Enter");
    await expect(denied.choice).resolves.toEqual({ approved: false, remember: false, reason: "wrong folder" });
    expect($(".agentic-chat-approval-outcome")?.textContent).toBe("Denied");
  });

  it("Esc in the reason disarms the deny; Enter on the card with the deny armed never allows", async () => {
    const c = ask(fakeApp(), { toolName: "write", args: { path: "a.md", content: "" } });
    button("Deny")?.click();
    expect(c.phase).toBe("deny-armed");
    key($<HTMLTextAreaElement>(".agentic-chat-deny-reason-input")!, "Escape");
    expect(c.phase).toBe("open");
    expect(button("Deny")).toBeDefined();

    button("Deny")?.click();
    key(c.el, "Enter");
    await expect(c.choice).resolves.toEqual({ approved: false, remember: false, reason: undefined });
  });

  it("settles as stopped when the turn aborts, and a late click does not change it", async () => {
    const controller = new AbortController();
    const c = ask(fakeApp(), { toolName: "write", args: { path: "a.md", content: "" } }, controller.signal);
    controller.abort();
    await expect(c.choice).resolves.toEqual({ approved: false, remember: false, reason: STOPPED_APPROVAL_REASON, stopped: true });
    expect($(".agentic-chat-approval-outcome")?.textContent).toBe("Stopped");
    button("Allow")?.click();
    expect(c.outcome).toBe("stopped");
  });

  it("settles at once when the turn was already aborted, and stop() (a closing tab) settles once", async () => {
    const controller = new AbortController();
    controller.abort();
    const early = ask(fakeApp(), { toolName: "write", args: { path: "a.md", content: "" } }, controller.signal);
    expect(early.settled).toBe(true);
    await expect(early.choice).resolves.toMatchObject({ stopped: true });

    const closing = ask(fakeApp(), { toolName: "write", args: { path: "a.md", content: "" } });
    closing.stop();
    closing.stop();
    await expect(closing.choice).resolves.toMatchObject({ approved: false, stopped: true });
  });
});
