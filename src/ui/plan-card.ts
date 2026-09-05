import { Modal, Notice, setIcon, type App } from "obsidian";
import {
  planEffortSummary,
  teaserLines,
  type PlanArtifact,
} from "../agent/plan-artifact";

/**
 * Inline plan card (copilot `PlanProposalCard` pattern): title +
 * DecisionChip, teaser, Open/Edit, Approve variants, Keep planning, and a
 * feedback box. Rendered inside the chat transcript — never a modal, so
 * approvals don't steal focus or resolve as deny on click-outside. The
 * parent unmounts the card after a decision; no stale Approved/Rejected
 * chip lingers.
 */

export type PlanApprovePosture = "manual" | "auto";

export interface PlanCardOptions {
  artifact: PlanArtifact;
  /** Context fill fraction (0-1) for the approve-gate note; null hides it. */
  contextFraction: number | null;
  /** Auto-apply (YOLO) is only offered when the posture permits it. */
  autoApplyAllowed: boolean;
  autoApplyDisabledReason?: string;
  /** Disables approve buttons with a stated reason (e.g. while streaming). */
  approveDisabledReason?: string;
}

export interface PlanCardCallbacks {
  /** Single decision: approval AND next posture (+ fresh-thread choice). */
  onApprove: (posture: PlanApprovePosture, freshThread: boolean) => void;
  onKeepPlanning: () => void;
  /** Feedback sends as a follow-up (reject + queued follow-up, no retype). */
  onFeedback: (text: string) => void;
  /** Edited plan markdown (parent re-detects, bumps revision, persists). */
  onEdit: (rawMarkdown: string) => void;
}

export interface PlanCardHandle {
  dispose: () => void;
}

export function renderPlanCard(
  parent: HTMLElement,
  app: App,
  options: PlanCardOptions,
  callbacks: PlanCardCallbacks,
): PlanCardHandle {
  const { artifact } = options;
  const card = parent.createDiv({ cls: "agentic-chat-plan-card" });

  const header = card.createDiv({ cls: "agentic-chat-plan-card-header" });
  const icon = header.createSpan({ cls: "agentic-chat-plan-card-icon" });
  setIcon(icon, "clipboard-list");
  header.createSpan({ cls: "agentic-chat-plan-card-title", text: artifact.title });
  header.createSpan({
    cls: `agentic-chat-plan-chip is-${artifact.status}`,
    text: `${artifact.status === "pending" ? "Pending" : artifact.status} · v${artifact.revision}`,
  });

  const meta = card.createDiv({ cls: "agentic-chat-plan-card-meta", text: planEffortSummary(artifact) });

  const teaser = card.createEl("ul", { cls: "agentic-chat-plan-card-teaser" });
  for (const line of teaserLines(artifact)) {
    teaser.createEl("li", { text: line });
  }
  if (artifact.steps.length > teaserLines(artifact).length) {
    meta.setText(`${planEffortSummary(artifact)} · showing ${teaserLines(artifact).length} of ${artifact.steps.length}`);
  }

  const full = card.createDiv({ cls: "agentic-chat-plan-card-full" });
  full.hide();
  const fullList = full.createEl("ol", { cls: "agentic-chat-plan-card-steps" });
  for (const step of artifact.steps) {
    const item = fullList.createEl("li");
    item.createSpan({ text: step.title });
    if (step.scope) item.createSpan({ cls: "agentic-chat-plan-card-scope", text: step.scope });
  }
  if (artifact.scopeFiles.length > 0) {
    full.createDiv({ cls: "agentic-chat-plan-card-scope-files", text: `Scope: ${artifact.scopeFiles.join(", ")}` });
  }

  const row = (cls: string): HTMLDivElement => card.createDiv({ cls });
  const primaryRow = row("agentic-chat-plan-card-row");
  const openBtn = primaryRow.createEl("button", { text: "Open full plan" });
  const editBtn = primaryRow.createEl("button", { text: "Edit plan" });
  openBtn.addEventListener("click", () => {
    const open = full.isShown();
    if (open) full.hide();
    else full.show();
    openBtn.setText(open ? "Open full plan" : "Hide full plan");
  });
  editBtn.addEventListener("click", () => {
    new PlanEditModal(app, artifact.rawMarkdown, (next) => callbacks.onEdit(next)).open();
  });

  const decisionRow = row("agentic-chat-plan-card-row");
  const approveBtn = decisionRow.createEl("button", { cls: "mod-cta", text: "Approve & implement" });
  const autoBtn = decisionRow.createEl("button", { cls: "mod-warning", text: "Approve & auto-apply" });
  const keepBtn = decisionRow.createEl("button", { text: "Keep planning" });
  if (options.approveDisabledReason) {
    for (const btn of [approveBtn, autoBtn]) {
      btn.disabled = true;
      btn.setAttr("title", options.approveDisabledReason);
    }
  }
  if (!options.autoApplyAllowed) {
    autoBtn.disabled = true;
    autoBtn.setAttr("title", options.autoApplyDisabledReason ?? "Auto-apply unavailable for this session.");
  }
  approveBtn.addEventListener("click", () => {
    new PlanApproveModal(app, artifact, options, "manual", (posture, freshThread) =>
      callbacks.onApprove(posture, freshThread),
    ).open();
  });
  autoBtn.addEventListener("click", () => {
    new PlanApproveModal(app, artifact, options, "auto", (posture, freshThread) =>
      callbacks.onApprove(posture, freshThread),
    ).open();
  });
  keepBtn.addEventListener("click", () => callbacks.onKeepPlanning());

  const feedbackWrap = row("agentic-chat-plan-card-feedback");
  const feedbackInput = feedbackWrap.createEl("textarea", {
    cls: "agentic-chat-plan-card-feedback-input",
    attr: { placeholder: "Feedback… (⌘/Ctrl+Enter sends, keeps planning)", rows: "2" },
  });
  if (artifact.feedbackDraft) feedbackInput.value = artifact.feedbackDraft;
  const feedbackBtn = feedbackWrap.createEl("button", { text: "Send feedback" });
  const sendFeedback = () => {
    const text = feedbackInput.value.trim();
    if (!text) {
      new Notice("Type feedback first — or Keep planning to continue without changes.");
      return;
    }
    callbacks.onFeedback(text);
  };
  feedbackBtn.addEventListener("click", sendFeedback);
  feedbackInput.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      sendFeedback();
    }
  });

  return {
    dispose: () => card.detach(),
  };
}

/** Edit the plan markdown in place; save bumps the revision (stable id). */
class PlanEditModal extends Modal {
  constructor(
    app: App,
    private readonly initial: string,
    private readonly onSave: (rawMarkdown: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Edit plan" });
    contentEl.createDiv({ cls: "setting-item-description", text: "Keep the title and step list — saving creates a new revision of the same plan." });
    const input = contentEl.createEl("textarea", { cls: "agentic-chat-plan-edit-input" });
    input.rows = 14;
    input.value = this.initial;
    const row = contentEl.createDiv({ cls: "agentic-chat-plan-card-row" });
    const save = row.createEl("button", { cls: "mod-cta", text: "Save revision" });
    const cancel = row.createEl("button", { text: "Cancel" });
    save.addEventListener("click", () => {
      const next = input.value.trim();
      if (!next) {
        new Notice("Plan can't be empty.");
        return;
      }
      this.onSave(next);
      this.close();
    });
    cancel.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * Single approve-gate decision (Claude Code 3-way pattern): approval AND the
 * next posture in one action, with the ambient context signal made decisive
 * ("context N% used — start fresh thread?").
 */
export class PlanApproveModal extends Modal {
  private posture: PlanApprovePosture;
  private freshThread = false;

  constructor(
    app: App,
    private readonly artifact: PlanArtifact,
    private readonly options: PlanCardOptions,
    defaultPosture: PlanApprovePosture,
    private readonly onConfirm: (posture: PlanApprovePosture, freshThread: boolean) => void,
  ) {
    super(app);
    this.posture = defaultPosture === "auto" && !options.autoApplyAllowed ? "manual" : defaultPosture;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Implement this plan?" });
    contentEl.createDiv({
      cls: "setting-item-description",
      text: `${this.artifact.title} — ${planEffortSummary(this.artifact)}.`,
    });
    if (this.artifact.scopeFiles.length > 0) {
      contentEl.createDiv({
        cls: "setting-item-description",
        text: `Scope: ${this.artifact.scopeFiles.join(", ")}`,
      });
    }
    if (this.options.contextFraction !== null) {
      const percent = Math.round(this.options.contextFraction * 100);
      const warn = contentEl.createDiv({ cls: "agentic-chat-plan-approve-context" });
      warn.setText(
        percent >= 80
          ? `Vault context ${percent}% used — consider starting a fresh thread below.`
          : `Vault context ${percent}% used.`,
      );
    }

    const postureWrap = contentEl.createDiv({ cls: "agentic-chat-plan-approve-postures" });
    const manual = postureWrap.createEl("button", { text: "Run with manual approval" });
    const auto = postureWrap.createEl("button", { text: "Auto-apply without asking" });
    const paint = () => {
      manual.toggleClass("mod-cta", this.posture === "manual");
      auto.toggleClass("mod-cta", this.posture === "auto");
    };
    manual.addEventListener("click", () => {
      this.posture = "manual";
      paint();
    });
    if (!this.options.autoApplyAllowed) {
      auto.disabled = true;
      auto.setAttr("title", this.options.autoApplyDisabledReason ?? "Auto-apply unavailable for this session.");
    } else {
      auto.addEventListener("click", () => {
        this.posture = "auto";
        paint();
      });
    }
    paint();

    const freshWrap = contentEl.createDiv({ cls: "agentic-chat-plan-approve-fresh" });
    const fresh = freshWrap.createEl("input", { attr: { type: "checkbox" } });
    fresh.checked = this.freshThread;
    freshWrap.createSpan({ text: "Start fresh thread (plan handed off with a re-read prefix)" });
    fresh.addEventListener("change", () => {
      this.freshThread = fresh.checked;
    });

    const row = contentEl.createDiv({ cls: "agentic-chat-plan-card-row" });
    const confirm = row.createEl("button", { cls: "mod-cta", text: "Implement" });
    const cancel = row.createEl("button", { text: "Keep planning" });
    confirm.addEventListener("click", () => {
      this.onConfirm(this.posture, this.freshThread);
      this.close();
    });
    cancel.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Minimal confirm dialog for destructive exits (e.g. aborting plan mode). */
export class ConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly title: string,
    private readonly body: string,
    private readonly confirmLabel: string,
    private readonly onConfirm: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.title });
    contentEl.createDiv({ cls: "setting-item-description", text: this.body });
    const row = contentEl.createDiv({ cls: "agentic-chat-plan-card-row" });
    const confirm = row.createEl("button", { cls: "mod-warning", text: this.confirmLabel });
    const cancel = row.createEl("button", { cls: "mod-cta", text: "Stay" });
    confirm.addEventListener("click", () => {
      this.onConfirm();
      this.close();
    });
    cancel.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
