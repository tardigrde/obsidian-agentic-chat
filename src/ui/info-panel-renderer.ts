import { setIcon } from "obsidian";
import type { ActionRow } from "./workflow-renderer";

export function renderInfoPanel(parent: HTMLElement, title: string, entries: Array<[string, string]>): HTMLElement {
  const el = parent.createDiv({ cls: ["agentic-chat-message", "agentic-chat-info"] });
  const details = el.createEl("details", { cls: "agentic-chat-info-details" });
  details.open = true;
  details.createEl("summary", { text: title });
  const list = details.createEl("ul", { cls: ["agentic-chat-info-body", "agentic-chat-info-list"] });
  for (const [label, value] of entries) {
    const item = list.createEl("li");
    item.createEl("code", { text: label });
    item.appendText(` — ${value}`);
  }
  return el;
}

export function renderSummaryPanel(parent: HTMLElement, text: string): HTMLElement {
  const inner = /<conversation-summary>\n?([\s\S]*?)\n?<\/conversation-summary>/.exec(text);
  const summary = (inner ? inner[1] : text).trim();
  const el = parent.createDiv({ cls: ["agentic-chat-message", "agentic-chat-info"] });
  const details = el.createEl("details", { cls: "agentic-chat-info-details" });
  details.createEl("summary", { text: "Summarized earlier conversation" });
  details.createDiv({ cls: "agentic-chat-info-body", text: summary });
  return el;
}

export function renderActionPanel(parent: HTMLElement, title: string, subtitle: string, items: ActionRow[]): HTMLElement {
  const el = parent.createDiv({ cls: ["agentic-chat-message", "agentic-chat-info"] });
  const details = el.createEl("details", { cls: "agentic-chat-info-details" });
  details.open = true;
  details.createEl("summary", { text: title });
  const body = details.createDiv({ cls: "agentic-chat-info-body" });
  if (subtitle) body.createDiv({ cls: "agentic-chat-info-subtitle", text: subtitle });
  const list = body.createDiv({ cls: "agentic-chat-action-list" });
  for (const item of items) {
    const row = list.createEl("button", { cls: "agentic-chat-action-row" });
    const icon = row.createSpan({ cls: "agentic-chat-action-row-icon" });
    setIcon(icon, item.icon);
    const main = row.createDiv({ cls: "agentic-chat-action-row-main" });
    main.createSpan({ cls: "agentic-chat-action-row-label", text: item.label });
    if (item.detail) main.createSpan({ cls: "agentic-chat-action-row-detail", text: item.detail });
    row.addEventListener("click", item.onClick);
  }
  return el;
}

export function renderErrorPanel(parent: HTMLElement, message: string): HTMLElement {
  const el = parent.createDiv({ cls: ["agentic-chat-message", "agentic-chat-info", "agentic-chat-info-error"] });
  const details = el.createEl("details", { cls: "agentic-chat-info-details" });
  details.open = true;
  details.createEl("summary", { text: "Error" });
  details.createDiv({ cls: "agentic-chat-info-body", text: message });
  return el;
}
