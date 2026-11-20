import { browser, expect, $ } from "@wdio/globals";
import { allowApproval, PENDING_APPROVAL, waitForApproval } from "../support/chat";
import { after, before, describe, it } from "mocha";
import { clearScriptedTurns, installScriptedTurns } from "../support/scripted-stream";

const MULTI_TAB_WRITE_PATH = "E2E-Multi-Tab-Write.md";

async function openChat(): Promise<void> {
  await browser.executeObsidianCommand("agentic-chat:open-chat");
  await $('[data-ac="view"]').waitForExist();
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
      approval: { mutating: string; perTool: Record<string, string> };
    };
    s.provider = "openrouter";
    s.openrouterApiKey = "e2e-scripted-key";
    s.mode = "safe";
    s.approval.mutating = "ask";
    s.approval.perTool = {};
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

  it("renders effort muted inside the model pill", async function () {
    const effort = await $('[data-ac="effort"]');
    await effort.waitForExist();
    const styles = await browser.execute(() => {
      const knob = document.querySelector<HTMLElement>('[data-ac="effort"]');
      const value = knob?.querySelector<HTMLElement>(".agentic-chat-effort-value");
      const name = document.querySelector<HTMLElement>('[data-ac="model-pill"] .agentic-chat-model-name');
      if (!knob || !value || !name) throw new Error("model or effort pill missing");
      const probe = document.createElement("span");
      probe.style.color = "var(--ac-text-faint)";
      knob.appendChild(probe);
      const faint = getComputedStyle(probe).color;
      probe.remove();
      return {
        samePill: knob.parentElement === name.closest('[data-ac="model-pill"]')?.parentElement,
        valueColour: getComputedStyle(value).color,
        nameColour: getComputedStyle(name).color,
        faint,
        valueFont: Number.parseFloat(getComputedStyle(value).fontSize),
        nameFont: Number.parseFloat(getComputedStyle(name).fontSize),
      };
    });
    // One pill: "Model · effort", with effort in the faint text colour.
    expect(styles.samePill).toBe(true);
    expect(styles.valueColour).toBe(styles.faint);
    expect(styles.valueColour).not.toBe(styles.nameColour);
    expect(styles.valueFont).toBeLessThanOrEqual(styles.nameFont);
  });

  it("keeps a background tab's approval in that tab with an orange dot (no auto-switch)", async function () {
    // Ensure we have 2 tabs
    await browser.execute(() => document.querySelector<HTMLElement>('[data-ac="tab-add"]')?.click());
    await browser.waitUntil(
      async () => {
        const count = (await browser.execute(() => document.querySelectorAll('[data-ac="tab"]').length)) as unknown as number;
        return count >= 2;
      },
      { timeout: 3_000 },
    );

    // Ensure Tab1 active then send write that needs approval
    await browser.execute(() => document.querySelectorAll<HTMLElement>('[data-ac="tab"]')[0]?.click());
    await browser.waitUntil(async () => await browser.execute(() => document.querySelectorAll<HTMLElement>('[data-ac="tab"]')[0]?.classList.contains("is-active")), { timeout: 2_000 });
    await browser.execute((msg) => {
      const textarea = document.querySelector<HTMLTextAreaElement>('[data-ac="composer-input"]');
      const send = document.querySelector<HTMLButtonElement>('[data-ac="send"]');
      if (!textarea || !send) throw new Error("composer missing");
      textarea.value = msg;
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      send.click();
    }, "trigger multi-tab write");

    // Switch to Tab2 once tab one's turn has started, before approval resolves:
    // the background approval must not steal focus.
    await browser.waitUntil(async () => await $('[data-ac="stop"]').isDisplayed(), {
      timeout: 5_000,
      timeoutMsg: "tab one's turn did not start",
    });
    await browser.execute(() => document.querySelectorAll<HTMLElement>('[data-ac="tab"]')[1]?.click());
    await browser.waitUntil(async () => await browser.execute(() => document.querySelectorAll<HTMLElement>('[data-ac="tab"]')[1]?.classList.contains("is-active")), { timeout: 2_000 });
    // The card waits in tab one's transcript; tab two shows none.
    await browser.waitUntil(async () => (await browser.execute(() => document.querySelectorAll<HTMLElement>('[data-ac="tab"]')[0]?.getAttribute("data-ac-state") ?? "")) === "needs-you", {
      timeout: 10_000,
      timeoutMsg: "tab one never showed the needs-you dot",
    });
    expect(await $(PENDING_APPROVAL).isExisting()).toBe(false);
    expect(await $(".modal-container").isExisting()).toBe(false);
    const { tab1State, tab1Dot, tab1Label, activeIndex } = await browser.execute(() => {
      const pills = Array.from(document.querySelectorAll<HTMLElement>('[data-ac="tab"]'));
      return {
        tab1State: pills[0]?.getAttribute("data-ac-state") ?? "",
        // The visible signal is the orange dot, not a class.
        tab1Dot: !!pills[0]?.querySelector(".agentic-chat-dot.is-needs-you"),
        tab1Label: pills[0]?.getAttribute("aria-label") ?? "",
        activeIndex: pills.findIndex((p) => p.classList.contains("is-active")),
      };
    });
    expect({ tab1State, tab1Dot }).toEqual({ tab1State: "needs-you", tab1Dot: true });
    expect(tab1Label).toBe("Tab 1, needs approval");
    expect(activeIndex).toBe(1);

    // Switching back shows the waiting card in tab one, below its activity line.
    await browser.execute(() => document.querySelectorAll<HTMLElement>('[data-ac="tab"]')[0]?.click());
    await waitForApproval();
    const placement = await browser.execute((selector) => {
      const card = document.querySelector(selector);
      return card?.parentElement?.previousElementSibling?.getAttribute("data-ac") ?? "";
    }, PENDING_APPROVAL);
    expect(placement).toBe("activity");
    await allowApproval();

    await browser.waitUntil(async () => {
      const exists = await browser.executeObsidian(async ({ app }, p) => !!app.vault.getAbstractFileByPath(p), MULTI_TAB_WRITE_PATH);
      return exists;
    }, { timeout: 10_000 });

    await browser.waitUntil(
      async () => !(await browser.execute(() => document.querySelectorAll<HTMLElement>('[data-ac="tab"]')[0]?.getAttribute("data-ac-state") ?? "")).includes("needs-you"),
      { timeout: 5_000, timeoutMsg: "the approval dot stayed on tab one" },
    );
  });

  it("settles the pending card and drops the dot when the background tab is closed", async function () {
    // Wait for previous turn to settle before starting next scenario
    await browser.waitUntil(async () => (await $('[data-ac="send"]').getAttribute("data-ac-state")) === "send", { timeout: 8_000 });
    await browser.execute(() => document.querySelectorAll<HTMLElement>('[data-ac="tab"]')[0]?.click());
    await browser.waitUntil(async () => await browser.execute(() => document.querySelectorAll<HTMLElement>('[data-ac="tab"]')[0]?.classList.contains("is-active")), { timeout: 2_000 });
    await browser.execute((msg) => {
      const textarea = document.querySelector<HTMLTextAreaElement>('[data-ac="composer-input"]');
      const send = document.querySelector<HTMLButtonElement>('[data-ac="send"]');
      textarea!.value = msg;
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
      send!.click();
    }, "trigger close while pending");

    await browser.waitUntil(async () => await $('[data-ac="stop"]').isDisplayed(), {
      timeout: 5_000,
      timeoutMsg: "tab one's turn did not start",
    });
    await browser.execute(() => document.querySelectorAll<HTMLElement>('[data-ac="tab"]')[1]?.click());
    await browser.waitUntil(async () => await browser.execute(() => document.querySelectorAll<HTMLElement>('[data-ac="tab"]')[1]?.classList.contains("is-active")), { timeout: 2_000 });
    await browser.waitUntil(async () => (await browser.execute(() => document.querySelectorAll<HTMLElement>('[data-ac="tab"]')[0]?.getAttribute("data-ac-state") ?? "")) === "needs-you", {
      timeout: 12_000,
      timeoutMsg: "tab one never asked for approval",
    });

    // Close tab one while its approval waits: the card settles as stopped.
    await browser.executeObsidian(async ({ app }) => {
      const leaves = app.workspace.getLeavesOfType("agentic-chat-chat-view");
      const view = leaves[0]?.view as unknown as { closeTab?: (index: number) => void };
      view?.closeTab?.(0);
    });
    await browser.waitUntil(async () => (await browser.execute(() => document.querySelectorAll('[data-ac="tab"]').length)) === 1, {
      timeout: 5_000,
      timeoutMsg: "tab one did not close",
    });
    expect(await $(PENDING_APPROVAL).isExisting()).toBe(false);
    expect(await browser.execute(() => document.querySelector('[data-ac="tab-overflow"] .agentic-chat-dot.is-needs-you'))).toBeNull();
  });

  after(async function () {
    await browser.executeObsidian(async ({ app, obsidian }, paths) => {
      for (const p of paths) {
        const f = app.vault.getAbstractFileByPath(p);
        if (f instanceof obsidian.TFile || f instanceof obsidian.TFolder) await app.vault.trash(f, true);
      }
    }, [MULTI_TAB_WRITE_PATH, "E2E-Multi-Tab-Close.md"]);
    await clearScriptedTurns();
  });
});
