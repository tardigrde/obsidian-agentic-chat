import { browser, $ } from "@wdio/globals";
import { describe, it, before } from "mocha";
import path from "node:path";
import { mkdirSync } from "node:fs";

/**
 * Clip regression: right side cut off after window resize / splitter drag.
 * Permanent suite — asserts no horizontal overflow (scrollWidth <= clientWidth,
 * view right <= leaf right) at 1200, 860, 760 widths. Screenshots in
 * logs/clip-debug for manual inspection. No AI vision, pure geometry.
 */

async function openChat(): Promise<void> {
  await browser.executeObsidianCommand("agentic-chat:open-chat");
  await $(".agentic-chat-view").waitForExist({ timeout: 5000 });
}

async function emitUser(text: string): Promise<void> {
  await browser.executeObsidian(
    async ({ app }, viewType, msg) => {
      const view = app.workspace.getLeavesOfType(viewType)[0]?.view as unknown as { handleAgentEvent?: (e: unknown) => void };
      if (!view?.handleAgentEvent) throw new Error(`chat view missing handleAgentEvent for ${viewType}`);
      view.handleAgentEvent({ type: "message_end", message: { role: "user", content: [{ type: "text", text: msg }] } });
    },
    "agentic-chat-chat-view",
    text,
  );
}

async function emitAssistant(text: string): Promise<void> {
  await browser.executeObsidian(
    async ({ app }, viewType, msg) => {
      const view = app.workspace.getLeavesOfType(viewType)[0]?.view as unknown as { handleAgentEvent?: (e: unknown) => void };
      if (!view?.handleAgentEvent) throw new Error(`chat view missing handleAgentEvent for ${viewType}`);
      view.handleAgentEvent({ type: "agent_start" });
      view.handleAgentEvent({ type: "message_start", message: { role: "assistant", content: [] } });
      view.handleAgentEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: msg } });
      view.handleAgentEvent({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: msg }] },
      });
      view.handleAgentEvent({ type: "agent_end" });
    },
    "agentic-chat-chat-view",
    text,
  );
}

async function checkNoClip(label: string): Promise<{ ok: boolean; details: string }> {
  return await browser.execute((lbl) => {
    const view = document.querySelector<HTMLElement>(".agentic-chat-view");
    const messages = document.querySelector<HTMLElement>(".agentic-chat-messages");
    const field = document.querySelector<HTMLElement>(".agentic-chat-field");
    const composer = document.querySelector<HTMLElement>(".agentic-chat-composer");
    const leaf = view?.closest<HTMLElement>(".workspace-leaf");
    if (!view || !leaf) return { ok: false, details: `${lbl}: view/leaf missing` };
    const leafRect = leaf.getBoundingClientRect();
    const viewRect = view.getBoundingClientRect();
    const checks: string[] = [];
    let ok = true;
    const testEl = (name: string, el: HTMLElement | null) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      // right edge must not exceed leaf right (allow 1.5px for subpixel)
      if (r.right > leafRect.right + 1.5) {
        ok = false;
        checks.push(`${name} right ${r.right.toFixed(1)} > leaf ${leafRect.right.toFixed(1)} diff ${(r.right - leafRect.right).toFixed(1)}`);
      }
      if (el.scrollWidth > el.clientWidth + 1.5) {
        // messages may scroll vertically, but horizontal scrollWidth should not exceed
        if (el.scrollWidth - el.clientWidth > 2) {
          // ignore vertical scrollbar gutter (~15px) — only flag large overflow
          const horizOverflow = el.scrollWidth - el.clientWidth;
          // field/composer horizontal overflow is always a bug
          if (name !== "messages" || horizOverflow > 16) {
            ok = false;
            checks.push(`${name} scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth} (+${horizOverflow})`);
          }
        }
      }
    };
    testEl("view", view);
    testEl("messages", messages);
    testEl("field", field);
    testEl("composer", composer);
    // also check that view itself is not wider than leaf
    if (viewRect.width > leafRect.width + 1.5) {
      ok = false;
      checks.push(`view width ${viewRect.width.toFixed(1)} > leaf ${leafRect.width.toFixed(1)}`);
    }
    return { ok, details: ok ? `${lbl}: ok leaf=${leafRect.width.toFixed(0)} view=${viewRect.width.toFixed(0)}` : `${lbl}: FAIL ${checks.join(" | ")}` };
  }, label);
}

describe("agentic-chat clip regression", function () {
  before(async function () {
    await openChat();
    await emitUser("hey whats up");
    await emitAssistant(
      "Hey! Ready when you are — want to capture a task, review a note, or dig into something in the vault?",
    );
    // ensure editor leaf exists for the "editor should show" case
    await browser.executeObsidian(async ({ app, obsidian }) => {
      const file = app.vault.getAbstractFileByPath("Welcome.md");
      if (file instanceof obsidian.TFile) {
        const leaf = app.workspace.getLeaf(false);
        await leaf.openFile(file);
      }
    });
  });

  it("no clip at 1200, then small window, then narrow sidebar (repro user steps)", async function () {
    const dir = path.resolve(`logs/clip-debug/${new Date().toISOString().replace(/[:.]/g, "-")}`);
    mkdirSync(dir, { recursive: true });

    // Capture original inline styles so the forced 340px leaf does not leak
    // into the final recovery check or later tests.
    const originalLeafStyles = await browser.execute(() => {
      const view = document.querySelector<HTMLElement>(".agentic-chat-view");
      const leaf = view?.closest<HTMLElement>(".workspace-leaf") as HTMLElement | null;
      const split = leaf?.closest<HTMLElement>(".workspace-split") as HTMLElement | null;
      return {
        leafFlex: leaf?.style.flex ?? "",
        leafWidth: leaf?.style.width ?? "",
        leafMinWidth: leaf?.style.minWidth ?? "",
        splitMinWidth: split?.style.minWidth ?? "",
      };
    });

    const widths: Array<{ w: number; h: number; name: string }> = [
      { w: 1200, h: 800, name: "01-1200-full" },
      { w: 860, h: 700, name: "02-860-small-window" },
      { w: 760, h: 700, name: "03-760-narrow" },
    ];

    try {
      for (const { w, h, name } of widths) {
        try {
          await browser.setWindowSize(w, h);
        } catch (_e) {
          // window resize best-effort on Obsidian runtime
        }
        await browser.pause(600);

        // force leaf sizer to be narrow like user's "editor + chat" state: shrink chat leaf to ~300px
        if (name.includes("760") || name.includes("860")) {
          await browser.execute(() => {
            const view = document.querySelector<HTMLElement>(".agentic-chat-view");
            const leaf = view?.closest<HTMLElement>(".workspace-leaf");
            const split = leaf?.closest<HTMLElement>(".workspace-split");
            if (leaf) {
              leaf.style.flex = "0 0 340px";
              (leaf.style as unknown as Record<string, string>).width = "340px";
              (leaf.style as unknown as Record<string, string>).minWidth = "280px";
            }
            if (split) split.style.minWidth = "0px";
          });
          await browser.pause(400);
        }

        const res = await checkNoClip(name);
        // eslint-disable-next-line no-console
        console.log(`[clip-debug] ${res.details} ok=${res.ok}`);

        const view = await $(".agentic-chat-view");
        if (await view.isExisting()) await view.saveScreenshot(path.join(dir, `${name}.view.png`));
        await browser.saveScreenshot(path.join(dir, `${name}.full.png`));

        if (!res.ok) throw new Error(res.details);
      }

      // Restore original leaf styles before widening so the final check
      // actually tests recovery, not a still-forced narrow leaf.
      await browser.execute((orig) => {
        const view = document.querySelector<HTMLElement>(".agentic-chat-view");
        const leaf = view?.closest<HTMLElement>(".workspace-leaf") as HTMLElement | null;
        const split = leaf?.closest<HTMLElement>(".workspace-split") as HTMLElement | null;
        if (leaf) {
          leaf.style.flex = orig.leafFlex;
          leaf.style.width = orig.leafWidth;
          (leaf.style as unknown as Record<string, string>).minWidth = orig.leafMinWidth;
        }
        if (split) split.style.minWidth = orig.splitMinWidth;
      }, originalLeafStyles);
      await browser.pause(300);

      // widen again to ensure no sticky overflow after resize back
      try {
        await browser.setWindowSize(1200, 800);
      } catch (_e) {
        // best-effort
      }
      await browser.pause(600);
      const final = await checkNoClip("04-back-to-1200");
      // eslint-disable-next-line no-console
      console.log(`[clip-debug] ${final.details} ok=${final.ok}`);
      if (!final.ok) throw new Error(final.details);
    } finally {
      // Always restore even if an assertion fails so later specs inherit clean state.
      await browser.execute((orig) => {
        const view = document.querySelector<HTMLElement>(".agentic-chat-view");
        const leaf = view?.closest<HTMLElement>(".workspace-leaf") as HTMLElement | null;
        const split = leaf?.closest<HTMLElement>(".workspace-split") as HTMLElement | null;
        if (leaf) {
          leaf.style.flex = orig.leafFlex;
          leaf.style.width = orig.leafWidth;
          (leaf.style as unknown as Record<string, string>).minWidth = orig.leafMinWidth;
        }
        if (split) split.style.minWidth = orig.splitMinWidth;
      }, originalLeafStyles);
    }
  });
});
