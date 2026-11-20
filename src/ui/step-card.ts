/** The detail of one activity-line step row: per-tool extras and ask-user state. */
import { formatCallBody, truncateText } from "./format";
import { type EditPair, isStringEditPair, readRangeText, renderStepEditDiff } from "./assistant-markdown";
import type { AskUserDetails } from "../tools/ask-user-tool";

/**
 * Render the step body extras. The title (label + clickable path) lives in the
 * row head, so the detail only holds per-tool extras: a read's line range, an
 * edit's mini oldText→newText diff, or readable key:value lines for other
 * tools. The Result/Error section is appended on endStep. The edit diff shows
 * the change itself (no file context at render time, unlike the approval card).
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
