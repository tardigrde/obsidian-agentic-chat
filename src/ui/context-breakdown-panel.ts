import { acHook } from "./test-hooks";

/**
 * The context ring's breakdown as a small panel above the composer card.
 * Desktop also shows it as the ring's hover tooltip; touch has no hover, so a
 * tap (or Enter / Space) opens this panel. Esc or a tap outside closes it.
 * The text is the ring's `title`, which the chrome keeps current: one source.
 * Returns a dispose: it closes the panel and removes its document listeners.
 */
export function wireContextBreakdownPanel(ringEl: HTMLElement, composerEl: HTMLElement): () => void {
  const panel = acHook(
    composerEl.createEl("pre", { cls: "agentic-chat-ctx-panel", attr: { role: "status", "aria-live": "polite" } }),
    "context-breakdown",
  );
  panel.hide();
  ringEl.setAttrs({ role: "button", tabindex: "0", "aria-expanded": "false", "aria-haspopup": "true" });
  const doc = ringEl.ownerDocument;
  const text = () => ringEl.getAttribute("title") ?? "";

  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    close();
    ringEl.focus();
  };
  const onPointerDown = (event: Event) => {
    const target = event.target as Node | null;
    if (target && (panel.contains(target) || ringEl.contains(target))) return;
    close();
  };
  // Keep the open panel current as the chrome updates the breakdown.
  const observer = new MutationObserver(() => panel.setText(text()));

  function open(): void {
    panel.setText(text());
    panel.show();
    ringEl.setAttr("aria-expanded", "true");
    doc.addEventListener("keydown", onKey);
    doc.addEventListener("pointerdown", onPointerDown, true);
    observer.observe(ringEl, { attributes: true, attributeFilter: ["title"] });
  }

  function close(): void {
    if (ringEl.getAttribute("aria-expanded") !== "true") return;
    panel.hide();
    ringEl.setAttr("aria-expanded", "false");
    doc.removeEventListener("keydown", onKey);
    doc.removeEventListener("pointerdown", onPointerDown, true);
    observer.disconnect();
  }

  const toggle = () => (ringEl.getAttribute("aria-expanded") === "true" ? close() : open());
  ringEl.addEventListener("click", toggle);
  ringEl.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggle();
  });
  return close;
}
