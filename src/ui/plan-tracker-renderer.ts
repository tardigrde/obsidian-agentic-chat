import { setIcon } from "obsidian";
import type { PlanTrackerPanelItem, PlanTrackerPanelState } from "./plan-tracker-panel";

export function renderPlanTrackerPanel(parent: HTMLElement, state: PlanTrackerPanelState): void {
  parent.empty();
  if (!state.visible) {
    parent.hide();
    return;
  }
  parent.show();

  const header = parent.createDiv({ cls: "agentic-chat-plan-header" });
  const title = header.createDiv({ cls: "agentic-chat-plan-title" });
  const icon = title.createSpan({ cls: "agentic-chat-plan-title-icon" });
  setIcon(icon, "list-checks");
  title.createSpan({ text: state.title });
  header.createDiv({ cls: "agentic-chat-plan-summary", text: state.summary });

  const list = parent.createDiv({ cls: "agentic-chat-plan-list" });
  for (const item of state.items) {
    const row = list.createDiv({ cls: ["agentic-chat-plan-row", `is-${item.status}`, `has-tests-${item.testStatus}`] });
    const status = row.createDiv({
      cls: "agentic-chat-plan-status",
      attr: { title: item.statusLabel, "aria-label": item.statusLabel },
    });
    setIcon(status, planTrackerStatusIcon(item.status));
    const main = row.createDiv({ cls: "agentic-chat-plan-main" });
    main.createSpan({ cls: "agentic-chat-plan-item-title", text: `${item.id}. ${item.title}` });
    const meta = main.createDiv({ cls: "agentic-chat-plan-meta" });
    meta.createSpan({ cls: "agentic-chat-plan-test", text: item.testLabel });
    if (item.checkpointCommit) {
      meta.createSpan({ cls: "agentic-chat-plan-commit", text: `commit ${item.checkpointCommit}` });
    }
    if (item.note) {
      meta.createSpan({ cls: "agentic-chat-plan-note", text: item.note });
    }
    row.createSpan({ cls: "agentic-chat-plan-badge", text: item.statusLabel });
  }
}

export function planTrackerStatusIcon(status: PlanTrackerPanelItem["status"]): string {
  switch (status) {
    case "done":
      return "check-circle-2";
    case "in_progress":
      return "play-circle";
    case "blocked":
      return "octagon-alert";
    case "pending":
      return "circle";
  }
}
