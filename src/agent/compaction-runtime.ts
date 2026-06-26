import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { generateSummary } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { AgenticChatSettings } from "../settings";
import { activeModelConfig, apiKeyForProvider } from "../settings";
import { buildModel } from "../llm/models";
import type { ObsidianSessionManager } from "../session/session-manager";
import { addUsage, emptyUsage, sumAssistantUsage } from "./usage";
import {
  DEFAULT_COMPACTION_CONFIG,
  buildSummaryMessage,
  getCompactedUsage,
  planCompaction,
  type CompactionConfig,
} from "./compaction";

const HTTP_REFERER = "https://github.com/tardigrde/obsidian-agentic-chat";
const X_TITLE = "Obsidian Agentic Chat";

/** Tokens reserved for the summarization prompt + its output during compaction. */
const COMPACTION_RESERVE_TOKENS = 16_384;

/** Abort the compaction summary call after this long so it can't stall a prompt. */
const COMPACTION_TIMEOUT_MS = 20_000;

/**
 * Summarize a slice of transcript into compaction summary text. Injected for
 * tests; production calls the model through pi's `generateSummary`. Returns "" to
 * signal "no summary" so the caller skips compaction rather than dropping history.
 */
export type SummarizeFn = (messages: AgentMessage[], signal?: AbortSignal) => Promise<string>;

export interface AgentCompactionRuntimeOptions {
  getSettings: () => AgenticChatSettings;
  sessionManager: ObsidianSessionManager;
  summarize?: SummarizeFn;
}

/**
 * Runs the transcript compaction pipeline: plan, summarize, carry usage, and
 * persist the rewritten session. The caller owns in-memory agent replacement and
 * UI notifications after a non-null result.
 */
export class AgentCompactionRuntime {
  private readonly getSettings: () => AgenticChatSettings;
  private readonly sessionManager: ObsidianSessionManager;
  private readonly injectedSummarize?: SummarizeFn;

  constructor(options: AgentCompactionRuntimeOptions) {
    this.getSettings = options.getSettings;
    this.sessionManager = options.sessionManager;
    this.injectedSummarize = options.summarize;
  }

  async compact(messages: AgentMessage[], contextWindow: number): Promise<AgentMessage[] | null> {
    const config = compactionConfig(this.getSettings());
    const plan = planCompaction(messages, contextWindow, config);
    if (!plan) return null;
    const summary = await this.summarizeForCompaction(plan.summarize);
    if (!summary.trim()) return null;
    // Carry the dropped turns' usage onto the summary message so the session
    // total is preserved on reload/rewind. Include usage already carried by an
    // earlier summary in this slice, so iterative compaction never loses it.
    const dropped = collectDroppedUsage(plan.summarize);
    const newMessages = [buildSummaryMessage(summary, Date.now(), dropped), ...plan.keep];
    // Persist the rewrite first; only mutate in-memory state once disk succeeds.
    await this.sessionManager.rewriteMessages(newMessages);
    return newMessages;
  }

  /**
   * Produce summary text for compaction. Tests inject a summarizer; production
   * summarizes through pi's `generateSummary` with the active model. The summary
   * call's own (small) token cost is not captured by `generateSummary`, so it is
   * left out of the session total.
   */
  private async summarizeForCompaction(messages: AgentMessage[]): Promise<string> {
    // Bound the summary call so a hung request can't stall the user's prompt.
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), COMPACTION_TIMEOUT_MS);
    try {
      if (this.injectedSummarize) return await this.injectedSummarize(messages, controller.signal);
      const settings = this.getSettings();
      const apiKey = apiKeyForProvider(settings, settings.provider);
      if (!apiKey) return "";
      const model = buildModel(activeModelConfig(settings));
      const result = await generateSummary(
        messages,
        model,
        COMPACTION_RESERVE_TOKENS,
        apiKey,
        { "HTTP-Referer": HTTP_REFERER, "X-Title": X_TITLE },
        controller.signal,
        undefined,
        undefined,
        settings.thinkingLevel,
      );
      return result.ok ? result.value : "";
    } finally {
      window.clearTimeout(timer);
    }
  }
}

/**
 * Total usage to carry onto a new summary: the assistant turns being dropped plus
 * any usage an earlier summary in the same slice already carried (iterative
 * compaction), so nothing is lost when the old summary is folded into the new one.
 */
function collectDroppedUsage(messages: AgentMessage[]): Usage {
  const total = emptyUsage();
  const assistant = sumAssistantUsage(messages);
  if (assistant) addUsage(total, assistant);
  for (const message of messages) {
    const carried = getCompactedUsage(message);
    if (carried) addUsage(total, carried);
  }
  return total;
}

/** Map the persisted (percent-based) compaction settings to a {@link CompactionConfig}. */
function compactionConfig(settings: AgenticChatSettings): CompactionConfig {
  const percent = settings.compaction?.thresholdPercent ?? DEFAULT_COMPACTION_CONFIG.thresholdFraction * 100;
  const thresholdFraction = Math.min(0.95, Math.max(0.5, percent / 100));
  return {
    enabled: settings.compaction?.enabled ?? DEFAULT_COMPACTION_CONFIG.enabled,
    thresholdFraction,
    keepFraction: DEFAULT_COMPACTION_CONFIG.keepFraction,
  };
}
