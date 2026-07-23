import {
  convertToLlm,
  serializeConversation,
  type AgentMessage,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import type { Model, Usage } from "@earendil-works/pi-ai";
import type { AgenticChatSettings } from "../settings";
import { activeModelConfig, apiKeyForProvider } from "../settings";
import { buildModel } from "../llm/models";
import { sharedAgentModels } from "../llm/providers";
import type { ObsidianSessionManager } from "../session/session-manager";
import { addUsage, emptyUsage, sumAssistantUsage } from "./usage";
import {
  DEFAULT_COMPACTION_CONFIG,
  buildSummaryMessage,
  collectCompactionManifest,
  estimateContextUsage,
  getCompactedUsage,
  planCompaction,
  type CompactionConfig,
} from "./compaction";

const HTTP_REFERER = "https://github.com/tardigrde/obsidian-agentic-chat";
const X_TITLE = "Obsidian Agentic Chat";

/** Tokens reserved for the summarization prompt + its output during compaction. */
const COMPACTION_RESERVE_TOKENS = 16_384;

/** Summary calls need more time than ordinary turn streaming on large sessions. */
const MIN_COMPACTION_TIMEOUT_MS = 60_000;

const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/**
 * Summarize a slice of transcript into compaction summary text. Injected for
 * tests; production calls the model through the same stream function used for
 * normal chat so requestUrl/proxy/retry behavior stays consistent.
 */
export type SummarizeFn = (
  messages: AgentMessage[],
  signal?: AbortSignal,
  customInstructions?: string,
  previousSummary?: string,
) => Promise<string>;

export interface AgentCompactionRuntimeOptionsForRun {
  /** Compact even when the transcript is below the automatic threshold. */
  force?: boolean;
  /** Optional user instructions to append to the summarization prompt. */
  customInstructions?: string;
}

export type AgentCompactionSkipReason =
  | "missing_api_key"
  | "no_plan"
  | "summary_empty"
  | "summary_failed";

export type AgentCompactionRunResult =
  | { status: "compacted"; messages: AgentMessage[] }
  | { status: "skipped"; reason: AgentCompactionSkipReason; message: string };

type SummaryResult =
  | { ok: true; summary: string }
  | { ok: false; reason: Exclude<AgentCompactionSkipReason, "no_plan">; message: string };

export interface AgentCompactionRuntimeOptions {
  getSettings: () => AgenticChatSettings;
  sessionManager: ObsidianSessionManager;
  buildStreamFn?: () => StreamFn;
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
  private readonly buildStreamFn: () => StreamFn;
  private readonly injectedSummarize?: SummarizeFn;

  constructor(options: AgentCompactionRuntimeOptions) {
    this.getSettings = options.getSettings;
    this.sessionManager = options.sessionManager;
    this.buildStreamFn =
      options.buildStreamFn ??
      (() => (model, context, streamOptions) => sharedAgentModels().streamSimple(model, context, streamOptions));
    this.injectedSummarize = options.summarize;
  }

  async compact(
    messages: AgentMessage[],
    contextWindow: number,
    options: AgentCompactionRuntimeOptionsForRun = {},
  ): Promise<AgentMessage[] | null> {
    const result = await this.compactWithResult(messages, contextWindow, options);
    return result.status === "compacted" ? result.messages : null;
  }

  async compactWithResult(
    messages: AgentMessage[],
    contextWindow: number,
    options: AgentCompactionRuntimeOptionsForRun = {},
  ): Promise<AgentCompactionRunResult> {
    const config = options.force
      ? { ...compactionConfig(this.getSettings()), enabled: true, thresholdFraction: 0 }
      : compactionConfig(this.getSettings());
    const plan = planCompaction(messages, contextWindow, config);
    if (!plan) {
      return {
        status: "skipped",
        reason: "no_plan",
        message: compactionNoPlanMessage(messages, contextWindow, config),
      };
    }
    const summary = await this.summarizeForCompaction(plan.summarize, contextWindow, options.customInstructions);
    if (!summary.ok) return { status: "skipped", reason: summary.reason, message: summary.message };
    if (!summary.summary.trim()) {
      return {
        status: "skipped",
        reason: "summary_empty",
        message: "Nothing compacted. The summary request returned no text, so the transcript was left unchanged.",
      };
    }
    // Carry the dropped turns' usage onto the summary message so the session
    // total is preserved on reload/rewind. Include usage already carried by an
    // earlier summary in this slice, so iterative compaction never loses it.
    const dropped = collectDroppedUsage(plan.summarize);
    const manifest = collectCompactionManifest(plan.summarize);
    const newMessages = [buildSummaryMessage(summary.summary, Date.now(), dropped, manifest), ...plan.keep];
    // Persist the rewrite first; only mutate in-memory state once disk succeeds.
    await this.sessionManager.rewriteMessages(newMessages);
    return { status: "compacted", messages: newMessages };
  }

  /**
   * Produce summary text for compaction. Tests inject a summarizer; production
   * summarizes through the same stream function as chat. The summary call's own
   * small token cost is not captured by the provider stream result, so it is left
   * out of the session total.
   */
  private async summarizeForCompaction(
    messages: AgentMessage[],
    contextWindow: number,
    customInstructions?: string,
  ): Promise<SummaryResult> {
    const chunks = chunkMessagesForSummary(messages, summaryInputBudget(contextWindow));
    let previousSummary: string | undefined;

    for (const chunk of chunks) {
      const result = this.injectedSummarize
        ? await this.summarizeInjectedChunk(chunk, customInstructions, previousSummary)
        : await this.summarizeModelChunk(chunk, customInstructions, previousSummary);
      if (!result.ok) return result;
      previousSummary = result.summary;
    }

    return { ok: true, summary: previousSummary ?? "" };
  }

  private async summarizeInjectedChunk(
    messages: AgentMessage[],
    customInstructions: string | undefined,
    previousSummary: string | undefined,
  ): Promise<SummaryResult> {
    // Bound the summary call so a hung request can't stall the user's prompt.
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), compactionTimeoutMs(this.getSettings()));
    try {
      return {
        ok: true,
        summary: await this.injectedSummarize!(messages, controller.signal, customInstructions, previousSummary),
      };
    } catch (error) {
      return {
        ok: false,
        reason: "summary_failed",
        message: `Nothing compacted. Summary request failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      window.clearTimeout(timer);
    }
  }

  private async summarizeModelChunk(
    messages: AgentMessage[],
    customInstructions: string | undefined,
    previousSummary: string | undefined,
  ): Promise<SummaryResult> {
    const settings = this.getSettings();
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), compactionTimeoutMs(settings));
    try {
      const apiKey = apiKeyForProvider(settings, settings.provider);
      if (!apiKey) {
        return {
          ok: false,
          reason: "missing_api_key",
          message: `Nothing compacted. No API key is available for ${settings.provider}.`,
        };
      }
      const model = buildModel(activeModelConfig(settings));
      return await generateSummaryWithStream(
        messages,
        model,
        this.buildStreamFn(),
        COMPACTION_RESERVE_TOKENS,
        apiKey,
        { "HTTP-Referer": HTTP_REFERER, "X-Title": X_TITLE },
        controller.signal,
        customInstructions,
        previousSummary,
        settings.thinkingLevel,
      );
    } catch (error) {
      return {
        ok: false,
        reason: "summary_failed",
        message: `Nothing compacted. Summary request failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      window.clearTimeout(timer);
    }
  }
}

async function generateSummaryWithStream(
  currentMessages: AgentMessage[],
  model: Model<"openai-completions">,
  streamFn: StreamFn,
  reserveTokens: number,
  apiKey: string,
  headers?: Record<string, string>,
  signal?: AbortSignal,
  customInstructions?: string,
  previousSummary?: string,
  thinkingLevel?: AgenticChatSettings["thinkingLevel"],
): Promise<SummaryResult> {
  const maxTokens = Math.min(
    Math.floor(0.8 * reserveTokens),
    model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
  );
  let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
  if (customInstructions) {
    basePrompt = `${basePrompt}\n\nAdditional instructions: ${customInstructions}`;
  }
  const llmMessages = convertToLlm(currentMessages);
  const conversationText = serializeConversation(llmMessages);
  let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
  if (previousSummary) {
    promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  }
  promptText += basePrompt;

  const summarizationMessages = [
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: promptText }],
      timestamp: Date.now(),
    },
  ];

  const responseStream = await streamFn(
    model,
    { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
    model.reasoning && thinkingLevel && thinkingLevel !== "off"
      ? { maxTokens, signal, apiKey, headers, reasoning: thinkingLevel }
      : { maxTokens, signal, apiKey, headers },
  );
  const response = await responseStream.result();
  if (response.stopReason === "aborted") {
    return {
      ok: false,
      reason: "summary_failed",
      message: `Nothing compacted. ${response.errorMessage || "Summarization aborted"}.`,
    };
  }
  if (response.stopReason === "error") {
    return {
      ok: false,
      reason: "summary_failed",
      message: `Nothing compacted. Summarization failed: ${response.errorMessage || "Unknown error"}.`,
    };
  }

  return {
    ok: true,
    summary: response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n"),
  };
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

function compactionNoPlanMessage(
  messages: AgentMessage[],
  contextWindow: number,
  config: CompactionConfig,
): string {
  if (!config.enabled) return "Nothing compacted. Auto-compaction is disabled in settings.";
  if (contextWindow <= 0) return "Nothing compacted. The active model has no known context window.";
  const userTurns = messages.filter((message) => message.role === "user").length;
  if (userTurns < 2) return `Nothing compacted. Need at least two user turns; this conversation has ${userTurns}.`;
  const tokens = estimateContextUsage(messages);
  const threshold = contextWindow * config.thresholdFraction;
  if (tokens <= threshold) {
    return `Nothing compacted. The conversation is below the compaction threshold (${tokens}/${Math.round(threshold)} estimated tokens).`;
  }
  return "Nothing compacted. No safe user-turn boundary was found.";
}

function summaryInputBudget(contextWindow: number): number {
  return Math.max(4_000, contextWindow - COMPACTION_RESERVE_TOKENS - 8_000);
}

function compactionTimeoutMs(settings: AgenticChatSettings): number {
  return Math.max(MIN_COMPACTION_TIMEOUT_MS, settings.requestTimeoutMs || 0);
}

function chunkMessagesForSummary(messages: AgentMessage[], maxTokens: number): AgentMessage[][] {
  if (messages.length === 0) return [];
  const chunks: AgentMessage[][] = [];
  let current: AgentMessage[] = [];
  let currentTokens = 0;

  for (const message of messages) {
    const tokens = estimateContextUsage([message]);
    if (current.length > 0 && currentTokens + tokens > maxTokens) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(message);
    currentTokens += tokens;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
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
