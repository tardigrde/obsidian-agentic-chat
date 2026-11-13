import {
  callPath,
  describeCall,
  formatCallBody,
  PATH_TOOLS,
  TOOL_LABELS,
  truncateText,
} from "./format";
import {
  type EditPair,
  isStringEditPair,
  middleEllipsis,
  readRangeText,
  renderStepEditDiff,
} from "./assistant-markdown";
import type { AskUserDetails } from "../tools/ask-user-tool";

/** Toggle a step's body open/closed and reflect state on the chevron + aria. */
export function toggleStep(row: HTMLElement): void {
  const card = row.querySelector(".agentic-chat-step");
  if (!card) return;
  const open = card.classList.toggle("is-open");
  row.classList.toggle("is-open", open);
  row.querySelector(".agentic-chat-step-toggle")?.setAttribute("aria-expanded", String(open));
}

/** Hide the chevron + collapse affordance when the body has nothing to show. */
export function syncStepCollapsible(row: HTMLElement, body: HTMLElement): void {
  const toggle = row.querySelector<HTMLElement>(".agentic-chat-step-toggle");
  if (!toggle) return;
  toggle.toggleClass("is-hidden", body.childElementCount === 0);
}

/** Render the header title: a readable label, with a clickable vault path for path-bearing tools. */
export function renderStepTitle(
  nameEl: HTMLElement,
  name: string,
  rawArgs: string,
  onOpenNote?: (path: string) => void,
): void {
  if (name.startsWith("mcp__")) {
    // "mcp__<server>__<tool>" → human "MCP · <tool>"; full id in the tooltip.
    const segments = name.split("__");
    nameEl.appendText(`MCP · ${segments.at(-1) ?? name}`);
    return;
  }
  if (PATH_TOOLS.has(name)) {
    nameEl.appendText(TOOL_LABELS[name] ?? `Running ${name}`);
    const path = callPath(rawArgs);
    if (path) {
      nameEl.appendText(": ");
      appendPathLink(nameEl, path, onOpenNote);
    }
    return;
  }
  nameEl.appendText(describeCall(name, rawArgs));
}

/**
 * Render the step body extras. The title (label + clickable path) lives in the
 * header, so the body only holds per-tool extras: a read's line range, an
 * edit's mini oldText→newText diff, or readable key:value lines for other
 * tools. The Result/Error section is appended on endStep. The edit diff shows
 * the change itself (no file context at render time, unlike the approval modal).
 */
export function renderCallSection(body: HTMLElement, name: string, rawArgs: string): void {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(rawArgs) as Record<string, unknown>;
  } catch {
    args = {};
  }

  if (name === "read" || name === "get_active_note") {
    const range = readRangeText(args);
    if (range) body.createDiv({ cls: "agentic-chat-step-call-args", text: range });
    return;
  }
  if (name === "edit") {
    const edits = Array.isArray(args.edits) ? args.edits.filter(isStringEditPair) : [];
    if (edits.length) {
      body.createDiv({ cls: "agentic-chat-step-call-args", text: `${edits.length} edit${edits.length === 1 ? "" : "s"}` });
      renderEditDiff(body, edits);
    }
    return;
  }
  if (name === "write") return; // title carries the path; success result is hidden
  // Non-path tools: readable key:value lines.
  const text = formatCallBody(name, rawArgs);
  if (text) body.createDiv({ cls: "agentic-chat-step-call-args", text });
}

/** Append a clickable vault-path link (opens the note via onOpenNote). */
export function appendPathLink(
  parent: HTMLElement,
  path: string,
  onOpenNote?: (path: string) => void,
): void {
  if (!path) {
    parent.appendText("(unknown path)");
    return;
  }
  const link = parent.createEl("a", { cls: "agentic-chat-step-path-link", attr: { href: "#", role: "button" } });
  // Middle-truncate long vault paths (keep the head/basename readable) instead
  // of ellipsis-ing only the tail, which hides the distinguishing filename.
  const display = path.length > 36 ? middleEllipsis(path, 36) : path;
  link.setText(display);
  link.setAttr("title", path);
  link.addEventListener("click", (event) => {
    event.preventDefault();
    onOpenNote?.(path);
  });
}

/** Render a compact oldText(−)/newText(+) diff, capped so it can't dominate the step. */
export function renderEditDiff(call: HTMLElement, edits: EditPair[]): void {
  renderStepEditDiff(call, edits);
}

export function renderAskUserStep(card: HTMLElement, details: AskUserDetails): void {
  let row = card.querySelector<HTMLElement>(".agentic-chat-step-ask-user");
  row ??= card.createDiv({ cls: "agentic-chat-step-ask-user" });
  row.empty();
  row.createDiv({
    cls: "agentic-chat-step-ask-user-status",
    text: details.status === "answered" ? "answered" : "waiting for user",
  });
  row.createDiv({ cls: "agentic-chat-step-ask-user-question", text: truncateText(details.question, 400) });
  if (details.answer) row.createDiv({ cls: "agentic-chat-step-ask-user-answer", text: truncateText(details.answer, 400) });
}
