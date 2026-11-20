import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { replayTextTurn, replayToolCallTurn } from "../../src/agent/replay-stream";
import { AC_HOOKS, acSelector, type AcHook } from "../../src/ui/test-hooks";
import { mountChatView, settle, type MountedChatView } from "./support/mount-chat-view";

/**
 * e2e specs, the chaos driver, evals, and dogfood find the chat view through
 * `data-ac` hooks, not CSS classes. This test renders the real view through a
 * turn with a tool call, an approval, and an answer, and checks that every hook
 * the drivers use is on the element it names.
 */

let ui: MountedChatView;

afterEach(async () => {
  await ui?.close();
});

const has = (hook: AcHook) => ui.$$(acSelector(hook)).length > 0;

describe("chat view test hooks", () => {
  it("marks the shell, tabs, and composer controls", async () => {
    ui = await mountChatView();
    for (const hook of [
      "view",
      "tab-strip",
      "tab",
      "tab-add",
      "header",
      "tab-overflow",
      "history",
      "messages",
      "empty",
      "composer",
      "composer-card",
      "composer-input",
      "chips",
      "send",
      "stop",
      "status",
      "model-pill",
      "effort",
      "mode-toggle",
      "context",
    ] satisfies AcHook[]) {
      expect(has(hook), hook).toBe(true);
    }
    expect(ui.$(acSelector("composer-input"))?.tagName).toBe("TEXTAREA");
    expect(ui.$(acSelector("send"))?.tagName).toBe("BUTTON");
    expect(ui.$(acSelector("view"))).toBe(ui.root);
  });

  it("marks the turn parts and the approval buttons", async () => {
    ui = await mountChatView({
      turns: [replayToolCallTurn("call-1", "write", { path: "Notes/new.md", content: "hello" }), replayTextTurn("written")],
    });
    await ui.send("create a note");
    await settle();

    expect(has("approval")).toBe(true);
    for (const hook of ["approval-allow", "approval-always", "approval-deny"] satisfies AcHook[]) {
      expect(ui.$(acSelector(hook))?.tagName, hook).toBe("BUTTON");
    }
    expect(ui.$(acSelector("approval-allow"))?.textContent).toBe("Allow");

    ui.$<HTMLButtonElement>(acSelector("approval-allow"))?.click();
    await ui.idle();

    for (const hook of ["user-message", "assistant-message", "assistant-text", "activity", "step", "turn-actions"] satisfies AcHook[]) {
      expect(has(hook), hook).toBe(true);
    }
    expect(ui.$$(acSelector("assistant-text")).at(-1)?.textContent).toContain("written");
    expect(ui.$(acSelector("step"))?.getAttribute("data-ac-state")).toBe("done");
    expect(ui.app.vault.contentOf("Notes/new.md")).toBe("hello");
  });

  it("marks info panels and the close control of a second tab", async () => {
    ui = await mountChatView();
    await ui.send("/help");
    expect(has("info")).toBe(true);
    expect(has("tab-close")).toBe(false);
    ui.$<HTMLElement>(acSelector("tab-add"))?.click();
    await settle();
    expect(ui.$$(acSelector("tab"))).toHaveLength(2);
    expect(ui.$$(acSelector("tab-close"))).toHaveLength(2);
  });

  it("every hook name is unique", () => {
    expect(new Set(AC_HOOKS).size).toBe(AC_HOOKS.length);
  });

  // Static checks over the whole tree, so a dropped hook or a typo in a spec
  // fails T1, not only the app lanes.
  // Vitest runs from the repo root (happy-dom has no file: import.meta.url).
  const root = process.cwd();
  const files = (dir: string, ext: RegExp): string[] =>
    readdirSync(path.join(root, dir), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && ext.test(entry.name))
      .map((entry) => path.join(entry.parentPath, entry.name));

  it("every hook in AC_HOOKS is applied somewhere in src", () => {
    const src = files("src", /\.ts$/)
      .filter((file) => !file.endsWith(path.join("ui", "test-hooks.ts")))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    const unused = AC_HOOKS.filter((hook) => !new RegExp(`acHook\\([^;]*?["']${hook}["']`, "s").test(src));
    expect(unused).toEqual([]);
  });

  it('every data-ac="…" a test, driver, or script selects is a known hook', () => {
    const known = new Set<string>(AC_HOOKS);
    const unknown: string[] = [];
    for (const file of [...files("test", /\.(ts|mjs)$/), ...files("scripts", /\.(ts|mjs)$/)]) {
      for (const match of readFileSync(file, "utf8").matchAll(/data-ac=\\?["']([a-z-]+)\\?["']/g)) {
        if (!known.has(match[1])) unknown.push(`${path.relative(root, file)}: ${match[1]}`);
      }
    }
    expect(unknown).toEqual([]);
  });
});
