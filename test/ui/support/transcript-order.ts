/**
 * The transcript as a reader sees it, top to bottom: one token per visible
 * thing in `[data-ac="messages"]`. Assertions compare this list with the
 * acceptance sentence ("text, then the tool row, then text") instead of
 * pinning DOM neighbours like `previousElementSibling` (U4 test gap 2).
 *
 *   user:<text>      a user bubble
 *   thought          a reasoning row
 *   step:<verb>      a tool row
 *   subagents        a segment's subagent section
 *   approval         a waiting approval card
 *   text:<text>      assistant text (first 24 characters)
 *   ask              a question card
 *
 * The same walk runs in the browser for e2e (`test/e2e/support/transcript-order.ts`).
 */
export function transcriptOrder(root: ParentNode): string[] {
  const messages = root.querySelector('[data-ac="messages"]');
  if (!messages) return [];
  const out: string[] = [];
  const short = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim().slice(0, 24);
  const visit = (el: Element): void => {
    const hook = el.getAttribute("data-ac");
    if (hook === "user-message") out.push(`user:${short(el.querySelector(".agentic-chat-user-text")?.textContent)}`);
    else if (hook === "thought") {
      if (!el.classList.contains("is-empty")) out.push("thought");
    } else if (hook === "step") out.push(`step:${short(el.querySelector(".agentic-chat-step-name")?.textContent)}`);
    else if (hook === "subagents") out.push("subagents");
    else if (hook === "approval") out.push("approval");
    else if (hook === "ask-user") out.push("ask");
    else if (hook === "assistant-message") {
      const text = short(el.querySelector('[data-ac="assistant-text"]')?.textContent);
      if (text) out.push(`text:${text}`);
    } else for (const child of Array.from(el.children)) visit(child);
  };
  for (const child of Array.from(messages.children)) visit(child);
  return out;
}
