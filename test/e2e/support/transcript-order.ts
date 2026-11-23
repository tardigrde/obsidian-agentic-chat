import { browser } from "@wdio/globals";

/**
 * The transcript as a reader sees it, top to bottom (real Obsidian). Same
 * tokens as `test/ui/support/transcript-order.ts`:
 * `user:<text>`, `thought`, `step:<verb>`, `report:<agent>`, `approval`,
 * `text:<first 24 chars>`, `ask`. Assert against the acceptance sentence, not
 * against DOM neighbours.
 */
export async function readTranscriptOrder(): Promise<string[]> {
  return await browser.execute(() => {
    const messages = document.querySelector('[data-ac="messages"]');
    if (!messages) return [];
    const out: string[] = [];
    const short = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim().slice(0, 24);
    const visit = (el: Element): void => {
      const hook = el.getAttribute("data-ac");
      if (hook === "user-message") out.push(`user:${short(el.querySelector(".agentic-chat-user-text")?.textContent)}`);
      else if (hook === "thought") {
        if (!el.classList.contains("is-empty")) out.push("thought");
      } else if (hook === "step") out.push(`step:${short(el.querySelector(".agentic-chat-step-name")?.textContent)}`);
      else if (hook === "subagent-event") out.push(`report:${short(el.querySelector("summary")?.textContent).split(" ")[1] ?? ""}`);
      else if (hook === "approval") out.push("approval");
      else if (hook === "ask-user") out.push("ask");
      else if (hook === "assistant-message") {
        const text = short(el.querySelector('[data-ac="assistant-text"]')?.textContent);
        if (text) out.push(`text:${text}`);
      } else for (const child of Array.from(el.children)) visit(child);
    };
    for (const child of Array.from(messages.children)) visit(child);
    return out;
  });
}

/** The order of the newest turn only: everything after the last user bubble. */
export async function readLastTurnOrder(): Promise<string[]> {
  const order = await readTranscriptOrder();
  const lastUser = order.map((token) => token.startsWith("user:")).lastIndexOf(true);
  return lastUser >= 0 ? order.slice(lastUser + 1) : order;
}
