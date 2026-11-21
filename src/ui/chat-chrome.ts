import type { App } from "obsidian";
import type { AgentService } from "../agent/agent-service";
import type { ContextReadout } from "../agent/readouts";
import type AgenticChatPlugin from "../main";
import { activeModelId } from "../settings-schema";
import type { ChatTabWorkingState } from "./chat-tab-state";
import { setIcon } from "obsidian";
import { buildModelPillState } from "./chrome-state";
import { CONTEXT_RING_LENGTH } from "./chat-layout";
import { contextLevel, contextPercent, formatContextBreakdown, lastPromptTokens } from "./context-bar";
import { highestUnnotifiedThreshold, type Notifier } from "./notifications";
import type { TranscriptView } from "./transcript-view";

/** What the round button does now; also the send button's `data-ac-state` test hook. */
export type SendAction = "send" | "stop" | "queue" | "update";

export interface ComposerSendInput {
  /** A turn runs in this tab. */
  running: boolean;
  /** A draft is held to send after the turn. */
  queued: boolean;
  /** The composer holds no text. */
  draftEmpty: boolean;
}

export interface ComposerSendState {
  action: SendAction;
  enabled: boolean;
  label: string;
  icon: "arrow-up" | "list-plus" | "square";
}

/**
 * The composer's one round button, as one table (U3 #12, U4 Stop/Queue):
 *
 * | running | queued | draft | action | enabled | label                       |
 * |---------|--------|-------|--------|---------|-----------------------------|
 * | no      | any    | any   | send   | yes     | Send                        |
 * | yes     | no     | empty | stop   | yes     | Stop (Esc)                  |
 * | yes     | no     | text  | queue  | yes     | Queue: send after this turn |
 * | yes     | yes    | any   | update | yes     | Update the queued message   |
 *
 * `stop` shows the Stop button in the same place; Escape in the composer stops
 * too, and Enter while a turn runs steers. Idle Send stays enabled with an
 * empty draft: Enter on nothing is a no-op, and the muted resting style says so.
 */
export function composerSendState(input: ComposerSendInput): ComposerSendState {
  if (!input.running) return { action: "send", enabled: true, label: "Send", icon: "arrow-up" };
  if (input.queued) return { action: "update", enabled: true, label: "Update the queued message", icon: "list-plus" };
  if (input.draftEmpty) return { action: "stop", enabled: true, label: "Stop (Esc)", icon: "square" };
  return { action: "queue", enabled: true, label: "Queue: send after this turn", icon: "list-plus" };
}

/** Context-window fill fractions that trigger a background notification, once each. */
export const CONTEXT_THRESHOLDS = [0.75, 0.9] as const;

export interface ChatChromeElements {
  effortKnobEl: () => HTMLElement | undefined;
  modelPillEl: () => HTMLElement;
  contextEl: () => HTMLElement;
  contextRingEl: () => SVGCircleElement;
  contextPercentEl: () => HTMLElement;
  sendButton: () => HTMLButtonElement;
  /** The composer textarea; an empty draft has nothing to queue. */
  composerInput: () => HTMLTextAreaElement | undefined;
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
  /** The running state the toolbar last rendered (from agent events or a sync). */
  private running = false;
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
    this.syncContextRing(readout);

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

  /** Context ring + percent in the toolbar; hidden until usage is known. */
  private syncContextRing(readout: ContextReadout | undefined): void {
    const el = this.deps.elements.contextEl();
    if (readout === undefined) {
      el.hide();
      return;
    }
    const percent = contextPercent(readout.fraction);
    const level = contextLevel(readout.fraction);
    el.show();
    el.setAttr("aria-label", `Context window ${percent}% used`);
    el.setAttr("title", formatContextBreakdown(readout, lastPromptTokens(this.deps.service().getMessages())));
    el.removeClasses(["is-ok", "is-warn", "is-high"]);
    el.addClass(`is-${level}`);
    const offset = CONTEXT_RING_LENGTH * (1 - Math.min(100, Math.max(0, percent)) / 100);
    this.deps.elements.contextRingEl().setAttribute("stroke-dashoffset", offset.toFixed(2));
    this.deps.elements.contextPercentEl().setText(`${percent}%`);
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
  }

  /** Notify when a turn finishes while the user is working elsewhere. */
  notifyTurnComplete(): void {
    if (this.deps.isViewFocused()) return;
    this.notifier.notify("agentFinished", "Agentic chat finished responding.");
  }

  setRunning(running: boolean): void {
    this.running = running;
    this.syncSendAvailability();
    const working = this.deps.elements.workingEl();
    working.parentElement?.toggleClass("is-running", running);
    const workingText = working.parentElement?.querySelector(".agentic-chat-working-text");
    if (workingText && workingText.textContent !== (running ? "Working…" : "")) workingText.textContent = running ? "Working…" : "";
    // One spinner per turn: the activity line spins while the turn runs, so the
    // status line says "Working…" without a second ring (U3 #5).
    working.hide();
    if (!running) this.deps.elements.statusEl().setText("");
  }

  /** Render the send button from {@link composerSendState}; on each running change and each input. */
  syncSendAvailability(): void {
    const sendButton = this.deps.elements.sendButton();
    const state = composerSendState({
      running: this.running,
      queued: this.deps.state().queuedPromptArmed,
      draftEmpty: !this.deps.elements.composerInput()?.value.trim(),
    });
    if (sendButton.getAttribute("data-ac-state") !== state.action) {
      sendButton.setAttribute("data-ac-state", state.action);
      sendButton.empty();
      setIcon(sendButton, state.icon);
    }
    sendButton.disabled = !state.enabled;
    // One round button: Stop takes the send button's place while the draft is empty.
    const stopButton = this.deps.elements.stopButton();
    if (state.action === "stop") {
      stopButton.show();
      sendButton.hide();
    } else {
      stopButton.hide();
      sendButton.show();
    }
    if (sendButton.getAttribute("aria-label") !== state.label) {
      sendButton.setAttr("aria-label", state.label);
      sendButton.setAttr("title", state.label);
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
