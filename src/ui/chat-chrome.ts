import type { App } from "obsidian";
import type { AgentService } from "../agent/agent-service";
import type { ContextReadout } from "../agent/readouts";
import { formatToolBudgetDiagnostic } from "../agent/diagnostics";
import type AgenticChatPlugin from "../main";
import { activeModelId } from "../settings-schema";
import type { ChatTabWorkingState } from "./chat-tab-state";
import {
  buildModelPillState,
  buildTurnUsageChromeParts,
  toolBudgetNotificationKey,
} from "./chrome-state";
import { contextLevel, contextPercent, formatContextReadoutTitle } from "./context-bar";
import { formatUsage } from "./format";
import { highestUnnotifiedThreshold, type Notifier } from "./notifications";
import type { TranscriptView } from "./transcript-view";

/** Context-window fill fractions that trigger a background notification, once each. */
export const CONTEXT_THRESHOLDS = [0.75, 0.9] as const;

export interface ChatChromeElements {
  effortKnobEl: () => HTMLElement | undefined;
  modelPillEl: () => HTMLElement;
  usageEl: () => HTMLElement;
  contextBarEl: () => HTMLProgressElement;
  contextPercentEl: () => HTMLElement;
  sendButton: () => HTMLButtonElement;
  stopButton: () => HTMLButtonElement;
  workingEl: () => HTMLElement;
  statusEl: () => HTMLElement;
}

export interface ChatChromeDeps {
  app: App;
  plugin: AgenticChatPlugin;
  service: () => AgentService;
  state: () => ChatTabWorkingState;
  transcript: () => TranscriptView;
  elements: ChatChromeElements;
  isAnyTabStreaming: () => boolean;
  isViewFocused: () => boolean;
  syncControls: () => void;
}

/**
 * Owns the model pill, running state, usage line, context bar, and one-shot
 * notifications. The view owns the DOM nodes; this class owns the rules that
 * decide what they show.
 */
export class ChatChrome {
  readonly notifier: Notifier;
  // The service fires onChange synchronously during session transitions; this silences
  // automatic toasts until the new session's notification baseline has been set.
  private muteNotifications = false;

  constructor(
    private readonly deps: ChatChromeDeps,
    notifier: Notifier,
  ) {
    this.notifier = notifier;
  }

  setMuteNotifications(muted: boolean): void {
    this.muteNotifications = muted;
  }

  syncChrome(): void {
    this.deps.syncControls();
    this.renderModelPill();
    this.syncEffortKnob();

    const readout = this.deps.service().getContextReadout();
    this.renderUsageChrome();
    this.syncContextBar(readout);

    this.renderRunning();
    this.checkUsageNotifications();
  }

  /** Header model pill: provider/model label plus the one-shot override state. */
  private renderModelPill(): void {
    const { settings } = this.deps.plugin;
    const el = this.deps.elements.modelPillEl();
    el.empty();
    const modelPill = buildModelPillState({
      provider: settings.provider,
      activeModelId: activeModelId(settings),
      overrideModelId: this.deps.service().getModelOverride(),
    });
    el.toggleClass("is-override", modelPill.isOverride);
    // Full slug in the tooltip; the pill shows a short label since OpenRouter ids are long.
    el.setAttr("title", modelPill.title);
    if (modelPill.isOverride) el.createSpan({ cls: "agentic-chat-model-provider", text: modelPill.providerLabel });
    el.createSpan({ cls: "agentic-chat-model-name", text: modelPill.shortModel });
  }

  /** Toolbar running state: queue/send label, stop button, and stale status clear. */
  private renderRunning(): void {
    const service = this.deps.service();
    const error = service.getError();
    this.setRunning(service.isStreaming());
    if (error && !service.isStreaming()) this.deps.elements.statusEl().setText("");
  }

  /**
   * Render the bottom usage line for the CURRENT turn only (Claude Code style):
   * collapsed `5.7k tokens · 86% cache · $0.17`, with the full per-turn detail in
   * the hover tooltip. Session-wide cumulative totals are dropped from the chrome
   * line (they still drive the cost/context notifications).
   */
  private renderUsageChrome(): void {
    const el = this.deps.elements.usageEl();
    el.empty();
    const turn = this.deps.transcript().lastTurnUsage;
    const session = this.deps.service().getSessionUsage();
    if (!turn || session.totalTokens === 0) {
      el.hide();
      return;
    }
    el.show();
    el.setAttr("title", `${formatUsage(turn)} · current turn`);
    const parts = buildTurnUsageChromeParts(turn);
    parts.forEach((part, index) => {
      if (index > 0) el.createSpan({ text: " · " });
      const span = el.createSpan({ text: part.text });
      if (part.cls) for (const cls of part.cls.split(" ")) if (cls) span.addClass(cls);
    });
  }

  /** Glanceable color-coded context-window fill bar; hidden until usage is known. */
  private syncContextBar(readout: ContextReadout | undefined): void {
    const barEl = this.deps.elements.contextBarEl();
    const percentEl = this.deps.elements.contextPercentEl();
    if (readout === undefined) {
      barEl.hide();
      percentEl.hide();
      return;
    }
    const fraction = readout.fraction;
    const percent = contextPercent(fraction);
    const title = formatContextReadoutTitle(readout);
    barEl.show();
    percentEl.show();
    barEl.setAttr("aria-label", `Context window ${percent}% used`);
    barEl.setAttr("title", title);
    barEl.value = percent;
    // Drive the CSS arc/gauge fill (conic-gradient ring) off the same percent
    // the helpers already compute — no new logic, just expose it to the style.
    barEl.style.setProperty("--ctx-pct", String(percent));
    barEl.removeClasses(["is-ok", "is-warn", "is-high"]);
    barEl.addClass(`is-${contextLevel(fraction)}`);
    percentEl.setText(`${percent}%`);
    percentEl.setAttr("title", title);
    percentEl.removeClasses(["is-ok", "is-warn", "is-high"]);
    percentEl.addClass(`is-${contextLevel(fraction)}`);
  }

  /** Fire one-shot background toasts as the context window fills or cost crosses the cap. */
  private checkUsageNotifications(): void {
    if (this.muteNotifications) return;
    const service = this.deps.service();
    const state = this.deps.state();
    const compactions = service.getCompactionCount();
    if (compactions > state.lastCompactionCount) {
      state.lastCompactionCount = compactions;
      // The window just freed up; re-arm the fill warnings for the next climb.
      state.notifiedContext = new Set<number>();
      this.notifier.notify("contextWindow", "Compacted earlier turns to free up context.");
    }
    const fraction = service.getContextFraction();
    if (fraction !== undefined) {
      const crossed = highestUnnotifiedThreshold(fraction, CONTEXT_THRESHOLDS, state.notifiedContext);
      if (crossed !== null) {
        state.notifiedContext.add(crossed);
        this.notifier.notify("contextWindow", `Context window ${Math.round(crossed * 100)}% full — consider /new soon.`);
      }
    }
    const cap = this.deps.plugin.settings.notifications.costAlertUsd;
    if (cap > 0 && !state.notifiedCost) {
      const cost = service.getSessionUsage().cost?.total ?? 0;
      if (cost >= cap) {
        state.notifiedCost = true;
        this.notifier.notify("cost", `This conversation has cost $${cost.toFixed(2)} (alert set at $${cap.toFixed(2)}).`);
      }
    }
    this.checkToolBudgetNotification();
  }

  private checkToolBudgetNotification(): void {
    const toolBudget = this.deps.service().getRuntimeDiagnostics().toolBudget;
    const key = toolBudgetNotificationKey(toolBudget);
    if (key === null) return;
    const state = this.deps.state();
    if (key === state.notifiedToolBudgetKey) return;
    state.notifiedToolBudgetKey = key;
    this.notifier.notify("info", `Agentic chat: ${formatToolBudgetDiagnostic(toolBudget)}.`);
  }

  /** Notify when a turn finishes while the user is working elsewhere. */
  notifyTurnComplete(): void {
    if (this.deps.isViewFocused()) return;
    this.notifier.notify("agentFinished", "Agentic chat finished responding.");
  }

  setRunning(running: boolean): void {
    const sendButton = this.deps.elements.sendButton();
    sendButton.disabled = false;
    let sendLabel: string;
    if (running) {
      sendLabel = this.deps.state().queuedPromptArmed ? "Update" : "Queue";
    } else {
      sendLabel = "Send";
    }
    sendButton.setText(sendLabel);
    if (running) {
      this.deps.elements.stopButton().show();
      this.deps.elements.workingEl().show();
    } else {
      this.deps.elements.stopButton().hide();
      this.deps.elements.workingEl().hide();
      this.deps.elements.statusEl().setText("");
    }
  }

  /**
   * Clear one-shot notification state. When `muteExisting` is set (loading a
   * session that may already be past a threshold), pre-mark crossed thresholds so
   * the user is only toasted about *new* crossings, not the loaded-in state.
   */
  resetUsageNotifications(muteExisting = false): void {
    const service = this.deps.service();
    const state = this.deps.state();
    state.notifiedContext = new Set<number>();
    state.notifiedCost = false;
    state.notifiedToolBudgetKey = null;
    state.lastCompactionCount = service.getCompactionCount();
    if (!muteExisting) return;
    const fraction = service.getContextFraction();
    if (fraction !== undefined) {
      for (const threshold of CONTEXT_THRESHOLDS) {
        if (fraction >= threshold) state.notifiedContext.add(threshold);
      }
    }
    const cap = this.deps.plugin.settings.notifications.costAlertUsd;
    if (cap > 0 && (service.getSessionUsage().cost?.total ?? 0) >= cap) {
      state.notifiedCost = true;
    }
    state.notifiedToolBudgetKey = toolBudgetNotificationKey(service.getRuntimeDiagnostics().toolBudget);
  }

  /** Render the composer effort knob from the level the next message will use. */
  syncEffortKnob(): void {
    const el = this.deps.elements.effortKnobEl();
    if (!el) return;
    const service = this.deps.service();
    const level = service.getActiveThinkingLevel();
    const levels = service.getActiveThinkingLevels();
    const canChange = levels.length > 1;
    el.empty();
    el.createSpan({ cls: "agentic-chat-effort-value", text: level });
    el.toggleClass("is-unavailable", !canChange);
    el.setAttr("aria-disabled", canChange ? "false" : "true");
    // Position on the model's supported ladder (0..1) so the knob reads as a
    // low→max scale, uniformly colored per step — no override split.
    const index = Math.max(0, levels.indexOf(level));
    const step = levels.length > 1 ? index / (levels.length - 1) : 0;
    el.style.setProperty("--effort-step", String(step));
    const hint = canChange
      ? `Reasoning effort for your messages: ${level}. Click to change. ` +
        "Switching effort re-processes the prompt once (a cache miss) — affects cost."
      : "Reasoning effort is off. The active model does not expose alternate reasoning effort levels.";
    el.setAttr("title", hint);
    el.setAttr("aria-label", hint);
  }
}
