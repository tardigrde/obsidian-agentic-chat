import { browser, expect, $ } from "@wdio/globals";
import { after, before, describe, it } from "mocha";

const MULTI_TAB_WRITE_PATH = "E2E-Multi-Tab-Write.md";

type ScriptedTurn = {
  label?: string;
  content: Array<Record<string, unknown>>;
  stopReason?: "stop" | "toolUse";
  delayMs?: number;
};

async function openChat(): Promise<void> {
  await browser.executeObsidianCommand("agentic-chat:open-chat");
  await $(".agentic-chat-view").waitForExist();
}

async function installScriptedTurns(turns: ScriptedTurn[]): Promise<void> {
  await browser.execute((scriptedTurns) => {
    const target = window as typeof window & {
      __AGENTIC_CHAT_E2E_TURNS__?: ScriptedTurn[];
      __AGENTIC_CHAT_E2E_CALLS__?: number;
      __AGENTIC_CHAT_E2E_CALL_LOG__?: unknown[];
    };
    target.__AGENTIC_CHAT_E2E_TURNS__ = scriptedTurns;
    target.__AGENTIC_CHAT_E2E_CALLS__ = 0;
    target.__AGENTIC_CHAT_E2E_CALL_LOG__ = [];
  }, turns);
}

async function configureSafe(): Promise<void> {
  await browser.executeObsidian(async ({ app }) => {
    const plugin = (app as unknown as {
      plugins?: { plugins?: Record<string, { settings?: Record<string, unknown>; saveSettings?: () => Promise<void> }> };
    }).plugins?.plugins?.["agentic-chat"];
    if (!plugin?.settings) throw new Error("plugin not found");
    const s = plugin.settings as {
      provider: string;
      openrouterApiKey: string;
      mode: string;
      approval: { mutating: string; perTool: Record<string, string>; workingDirs: string[] };
    };
    s.provider = "openrouter";
    s.openrouterApiKey = "e2e-scripted-key";
    s.mode = "safe";
    s.approval.mutating = "ask";
    s.approval.perTool = {};
    s.approval.workingDirs = [];
    await plugin.saveSettings?.();
  });
}

describe("multi-tab background approval (effort + notify+label)", function () {
  before(async function () {
    await browser.executeObsidian(async ({ app, obsidian }, path) => {
      const file = app.vault.getAbstractFileByPath(path);
      if (file instanceof obsidian.TFile || file instanceof obsidian.TFolder) await app.vault.trash(file, true);
    }, MULTI_TAB_WRITE_PATH);
    await installScriptedTurns([
      {
        label: "multi-tab write",
        stopReason: "toolUse",
        delayMs: 1200,
        content: [{ type: "toolCall", id: "e2e-multi-tab-write", name: "write", arguments: { path: MULTI_TAB_WRITE_PATH, content: "multi-tab ok" } }],
      },
      { label: "multi-tab final", stopReason: "stop", content: [{ type: "text", text: "Wrote multi-tab note." }] },
      {
        label: "multi-tab write close",
        stopReason: "toolUse",
        delayMs: 1200,
        content: [{ type: "toolCall", id: "e2e-multi-tab-write-close", name: "write", arguments: { path: "E2E-Multi-Tab-Close.md", content: "close" } }],
      },
      { label: "close final", stopReason: "stop", content: [{ type: "text", text: "Wrote close." }] },
    ]);
    const ok = await configureSafe();
    void ok;
    await openChat();
  });

  it("renders effort pill subordinate to model pill", async function () {
    const effort = await $(".agentic-chat-effort-value");
    await effort.waitForExist();
    const styles = await browser.execute(() => {
      const el = document.querySelector<HTMLElement>(".agentic-chat-effort-value");
      const knob = document.querySelector<HTMLElement>(".agentic-chat-effort");
      if (!el || !knob) throw new Error("effort pill missing");
      const cs = getComputedStyle(el);
      const knobCs = getComputedStyle(knob);
      return {
        fontSize: cs.fontSize,
        padding: knobCs.padding,
        lineHeight: cs.lineHeight,
      };
    });
    // Effort should be ~0.92*font-smallest (~10-11px) not font-ui-smaller (~13px), and knob padding 1px 5px
    const px = parseFloat(styles.fontSize);
    expect(px).toBeLessThan(12);
    expect(styles.padding).toContain("1px");
    expect(styles.padding).toContain("5px");
  });

  it("surfaces background tab approval with tab badge and session label (no auto-switch)", async function () {
    // Ensure we have 2 tabs
    await browser.execute(() => document.querySelector<HTMLElement>(".agentic-chat-tab-add")?.click());
    await browser.waitUntil(
      async () => {
        const count = (await browser.execute(() => document.querySelectorAll(".agentic-chat-tab").length)) as unknown as number;
        return count >= 2;
      },
      { timeout: 3_000 },
    );

    // Ensure Tab1 active then send write that needs approval
    await browser.execute(() => document.querySelectorAll<HTMLElement>(".agentic-chat-tab")[0]?.click());
    await browser.waitUntil(async () => await browser.execute(() => document.querySelectorAll<HTMLElement>(".agentic-chat-tab")[0]?.classList.contains("is-active")), { timeout: 2_000 });
    await browser.execute((msg) => {
      const textarea = document.querySelector<HTMLTextAreaElement>(".agentic-chat-input");
      const send = document.querySelector<HTMLButtonElement>(".agentic-chat-send");
      if (!textarea || !send) throw new Error("composer missing");
      textarea.value = msg;
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      send.click();
    }, "trigger multi-tab write");

    // Quickly switch to Tab2 before approval resolves — background approval should not steal focus
    await browser.pause(300);
    await browser.execute(() => document.querySelectorAll<HTMLElement>(".agentic-chat-tab")[1]?.click());
    await browser.waitUntil(async () => await browser.execute(() => document.querySelectorAll<HTMLElement>(".agentic-chat-tab")[1]?.classList.contains("is-active")), { timeout: 2_000 });
    // Give tool time to hit approval gate (tool has 1200ms delay)
    await browser.pause(1300);

    const modal = await $(".agentic-chat-approval");
    await modal.waitForExist({ timeout: 10_000 });

    // Modal title should contain Tab 1 session label, and content Session line — check via DOM, no click behind overlay
    const title = await browser.execute(() => document.querySelector<HTMLElement>(".modal-title")?.innerText ?? "");
    expect(title).toContain("Tab 1");
    const sessionLine = await browser.execute(() => document.querySelector<HTMLElement>(".agentic-chat-approval-session")?.innerText ?? "");
    expect(sessionLine).toContain("Tab 1");

    // Background Tab1 pill should pulse needs-approval, Tab2 should be active — inspect via execute, not click (modal blocks)
    const { tab1Class, activeIndex } = await browser.execute(() => {
      const pills = Array.from(document.querySelectorAll<HTMLElement>(".agentic-chat-tab"));
      return {
        tab1Class: pills[0]?.className ?? "",
        activeIndex: pills.findIndex((p) => p.classList.contains("is-active")),
      };
    });
    expect(tab1Class).toContain("is-needs-approval");
    expect(activeIndex).toBe(1);

    // Approve from background — should create file and clear badge
    const allow = await modal.$("button=Allow");
    await allow.click();
    await modal.waitForExist({ reverse: true, timeout: 5_000 });

    await browser.waitUntil(async () => {
      const exists = await browser.executeObsidian(async ({ app }, p) => !!app.vault.getAbstractFileByPath(p), MULTI_TAB_WRITE_PATH);
      return exists;
    }, { timeout: 10_000 });

    await browser.pause(300);
    const tab1ClassAfter = await browser.execute(() => document.querySelectorAll<HTMLElement>(".agentic-chat-tab")[0]?.className ?? "");
    expect(tab1ClassAfter).not.toContain("is-needs-approval");
  });

  it("clears pending modal and badge when background tab is closed", async function () {
    // Wait for previous turn to settle before starting next scenario
    await browser.waitUntil(async () => (await $(".agentic-chat-send").getText()).trim() === "Send", { timeout: 8_000 });
    await browser.execute(() => document.querySelectorAll<HTMLElement>(".agentic-chat-tab")[0]?.click());
    await browser.waitUntil(async () => await browser.execute(() => document.querySelectorAll<HTMLElement>(".agentic-chat-tab")[0]?.classList.contains("is-active")), { timeout: 2_000 });
    await browser.execute((msg) => {
      const textarea = document.querySelector<HTMLTextAreaElement>(".agentic-chat-input");
      const send = document.querySelector<HTMLButtonElement>(".agentic-chat-send");
      textarea!.value = msg;
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
      send!.click();
    }, "trigger close while pending");

    await browser.pause(300);
    await browser.execute(() => document.querySelectorAll<HTMLElement>(".agentic-chat-tab")[1]?.click());
    await browser.waitUntil(async () => await browser.execute(() => document.querySelectorAll<HTMLElement>(".agentic-chat-tab")[1]?.classList.contains("is-active")), { timeout: 2_000 });
    await browser.pause(2000);
    await $(".agentic-chat-approval").waitForExist({ timeout: 12_000 });

    // Close Tab1 while its approval modal is open — use direct JS (modal blocks tab clicks) to close tab, modal should close
    await browser.executeObsidian(async ({ app }) => {
      const leaves = app.workspace.getLeavesOfType("agentic-chat-chat-view");
      const view = leaves[0]?.view as unknown as { closeTab?: (index: number) => void };
      view?.closeTab?.(0);
    });
    await $(".agentic-chat-approval").waitForExist({ reverse: true, timeout: 5_000 });
    expect(await $(".agentic-chat-approval").isExisting()).toBe(false);
  });

  after(async function () {
    await browser.executeObsidian(async ({ app, obsidian }, paths) => {
      for (const p of paths) {
        const f = app.vault.getAbstractFileByPath(p);
        if (f instanceof obsidian.TFile || f instanceof obsidian.TFolder) await app.vault.trash(f, true);
      }
    }, [MULTI_TAB_WRITE_PATH, "E2E-Multi-Tab-Close.md"]);
    await browser.execute(() => {
      const t = window as typeof window & { __AGENTIC_CHAT_E2E_TURNS__?: unknown };
      delete t.__AGENTIC_CHAT_E2E_TURNS__;
    });
  });
});
