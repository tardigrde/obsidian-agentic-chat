/**
 * Stable test hooks for the chat view. Each hooked element carries
 * `data-ac="<hook>"`. e2e specs, the chaos driver, evals, and dogfood select by
 * these hooks, not by CSS class names, so a restyle cannot break them.
 *
 * A hook names what the element is for, not how it looks. Keep the list short:
 * add a hook only when a test or driver needs to find the element.
 */
export const AC_HOOKS = [
  "view",
  "header",
  "tab-strip",
  "tab",
  "tab-label",
  "tab-input",
  "tab-close",
  "tab-add",
  "tab-overflow",
  "tab-menu",
  "history",
  "messages",
  "empty",
  "user-message",
  "assistant-message",
  "assistant-text",
  "info",
  "error",
  "turn-error",
  "ask-user",
  "ask-input",
  "ask-submit",
  "ask-record",
  "activity",
  "activity-head",
  "activity-body",
  "step",
  "approval",
  "approval-allow",
  "approval-always",
  "approval-deny",
  "turn-actions",
  "turn-meta",
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
  "context-breakdown",
  "session-cost",
] as const;

export type AcHook = (typeof AC_HOOKS)[number];

/**
 * Steps also carry `data-ac-state` (`running`, `done`, or `error`), so a driver
 * can wait for a settled step without reading style classes.
 */
export type AcStepState = "running" | "done" | "error";

/** Mark `el` with a stable test hook. Returns `el` for chaining. */
export function acHook<T extends HTMLElement>(el: T, hook: AcHook): T {
  el.setAttribute("data-ac", hook);
  return el;
}

/** CSS selector for a hook: `[data-ac="send"]`. */
export function acSelector(hook: AcHook): string {
  return `[data-ac="${hook}"]`;
}
