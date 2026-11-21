import { acHook } from "./test-hooks";
import { setIcon } from "obsidian";
import type { ActionRow } from "./workflow-renderer";
import { doctorProblemLine, doctorStatusLine, type DoctorReport } from "../agent/doctor-report";

export function renderInfoPanel(parent: HTMLElement, title: string, entries: Array<[string, string]>): HTMLElement {
  const el = acHook(parent.createDiv({ cls: ["agentic-chat-message", "agentic-chat-info"] }), "info");
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

/**
 * `/doctor` (U4 #17): the status, then problems with their fix, the
 * essentials, notes, and closed sections (counts on top, names inside).
 */
export function renderDoctorPanel(parent: HTMLElement, report: DoctorReport): HTMLElement {
  const el = acHook(parent.createDiv({ cls: ["agentic-chat-message", "agentic-chat-info", "agentic-chat-doctor"] }), "info");
  el.setAttribute("data-ac-state", report.status);
  const details = el.createEl("details", { cls: "agentic-chat-info-details" });
  details.open = true;
  details.createEl("summary", { text: `Doctor · ${doctorStatusLine(report)}` });
  const body = details.createDiv({ cls: "agentic-chat-info-body" });
  if (report.problems.length > 0) {
    const problems = body.createEl("ul", { cls: ["agentic-chat-info-list", "agentic-chat-doctor-problems"] });
    for (const problem of report.problems) {
      const item = problems.createEl("li", { cls: `is-${problem.severity}` });
      item.setAttribute("data-code", problem.code);
      item.createDiv({ text: doctorProblemLine(problem) });
      item.createDiv({ cls: "agentic-chat-doctor-fix", text: `Fix: ${problem.fix}` });
    }
  }
  const essentials = body.createEl("ul", { cls: ["agentic-chat-info-list", "agentic-chat-doctor-essentials"] });
  for (const [label, value] of report.essentials) {
    const item = essentials.createEl("li");
    item.createEl("code", { text: label });
    item.appendText(` — ${value}`);
  }
  for (const note of report.notes) body.createDiv({ cls: "agentic-chat-doctor-note", text: note });
  for (const section of report.sections) {
    const fold = body.createEl("details", { cls: "agentic-chat-doctor-section" });
    fold.createEl("summary", { text: `${section.title} · ${section.summary}` });
    const list = fold.createEl("ul", { cls: "agentic-chat-info-list" });
    for (const [label, value] of section.rows) {
      const item = list.createEl("li");
      item.createEl("code", { text: label });
      item.appendText(` — ${value}`);
    }
  }
  return el;
}

export function renderSummaryPanel(parent: HTMLElement, text: string): HTMLElement {
  const inner = /<conversation-summary>\n?([\s\S]*?)\n?<\/conversation-summary>/.exec(text);
  const summary = (inner ? inner[1] : text).trim();
  const el = acHook(parent.createDiv({ cls: ["agentic-chat-message", "agentic-chat-info"] }), "info");
  const details = el.createEl("details", { cls: "agentic-chat-info-details" });
  details.createEl("summary", { text: "Summarized earlier conversation" });
  details.createDiv({ cls: "agentic-chat-info-body", text: summary });
  return el;
}

export function renderActionPanel(parent: HTMLElement, title: string, subtitle: string, items: ActionRow[]): HTMLElement {
  const el = acHook(parent.createDiv({ cls: ["agentic-chat-message", "agentic-chat-info"] }), "info");
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
  const el = acHook(parent.createDiv({ cls: ["agentic-chat-message", "agentic-chat-info", "agentic-chat-info-error"] }), "error");
  const details = el.createEl("details", { cls: "agentic-chat-info-details" });
  details.open = true;
  details.createEl("summary", { text: "Error" });
  details.createDiv({ cls: "agentic-chat-info-body", text: message });
  return el;
}
