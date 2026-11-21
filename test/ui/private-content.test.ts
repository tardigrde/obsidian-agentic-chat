import { afterEach, describe, expect, it } from "vitest";
import { replayTextTurn, replayToolCallTurn } from "../../src/agent/replay-stream";
import { mountChatView, seedFile, settle, type MountedChatView } from "./support/mount-chat-view";

/**
 * U4 #11 (owner decision 2026-11-21): private content. The real view and
 * AgentService run; only the model is scripted.
 */

let ui: MountedChatView;

afterEach(async () => {
  await ui?.close();
});

function toolResultTexts(): string[] {
  const view = ui.view as unknown as { service: { getMessages: () => Array<{ role: string; content?: unknown }> } };
  return view.service
    .getMessages()
    .filter((message) => message.role === "toolResult")
    .map((message) => JSON.stringify(message.content));
}

describe("private content (U4 #11)", () => {
  it("a write to a private path is blocked before the approval card: no card, no checkpoint, an honest reason", async () => {
    ui = await mountChatView({
      turns: [
        replayToolCallTurn("w1", "write", { path: "Private/plan.md", content: "secret" }),
        replayTextTurn("I cannot write there; it is private."),
      ],
      settings: { ignoredGlobs: "Private/", approval: { mutating: "ask", perTool: {} } },
    });
    await ui.send("write my plan into Private/plan.md");
    await settle();
    // No approval card ever showed: the user was not asked to approve a call that must fail.
    expect(ui.$$('[data-ac="approval"]')).toHaveLength(0);
    await ui.idle();
    expect(ui.app.vault.contentOf("Private/plan.md")).toBeUndefined();
    const results = toolResultTexts().join("\n");
    expect(results).toContain('Blocked: \\"Private/plan.md\\" is private (excluded in settings)');
    expect(results).not.toContain("File not found");
  });

  it("a folder whose children are all private says so, never '(empty folder)'", async () => {
    ui = await mountChatView({
      turns: [replayToolCallTurn("l1", "vault_inspect", { action: "list", path: "Journal" }), replayTextTurn("listed")],
      settings: { ignoredGlobs: "*.secret.md, #private" },
    });
    await seedFile(ui.app, "Journal/a.secret.md", "a");
    await seedFile(ui.app, "Journal/b.secret.md", "b");
    await ui.send("what is in Journal?");
    await ui.idle();
    const results = toolResultTexts().join("\n");
    expect(results).toContain("2 private items hidden (excluded in settings).");
    expect(results).not.toContain("(empty folder)");
  });

  it("a private active note shows a lock chip and nothing of it is sent", async () => {
    ui = await mountChatView({ turns: [replayTextTurn("ok")], settings: { ignoredGlobs: "Private/" } });
    const file = await seedFile(ui.app, "Private/diary.md", "DIARY-BODY very personal");
    ui.app.workspace.activeFile = file;
    ui.app.workspace.trigger("file-open", file);
    await settle();
    const chip = ui.$('[data-ac="private-chip"]');
    expect(chip?.textContent).toContain("private, not sent");
    expect(ui.$$(".agentic-chat-chip.is-active-note")).toHaveLength(0);
    await ui.send("summarize this");
    await ui.idle();
    const view = ui.view as unknown as { service: { getMessages: () => unknown[] } };
    expect(JSON.stringify(view.service.getMessages())).not.toContain("DIARY-BODY");
  });
});
