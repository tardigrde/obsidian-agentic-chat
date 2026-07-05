import { estimateTokens, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { collectArtifactIdsFromText } from "../artifacts/artifact-references";

/**
 * Auto-compaction configuration. Fractions are of the model's context window.
 * Kept separate from the persisted settings shape (which stores percents) so this
 * module stays pure and testable without depending on `AgenticChatSettings`.
 */
export interface CompactionConfig {
  /** Enable automatic summarization of old turns as context fills. */
  enabled: boolean;
  /** Fill fraction (0–1) at which compaction triggers. */
  thresholdFraction: number;
  /** Fraction (0–1) of recent context to retain verbatim after compaction. */
  keepFraction: number;
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  enabled: true,
  thresholdFraction: 0.8,
  keepFraction: 0.3,
};

/** A decision to fold `summarize` into a summary and keep `keep` verbatim. */
export interface CompactionPlan {
  /** Older messages to fold into a single summary message. */
  summarize: AgentMessage[];
  /** Recent messages retained verbatim, beginning at a user-turn boundary. */
  keep: AgentMessage[];
  /** Estimated context tokens before compaction (for logging/notices). */
  tokensBefore: number;
}

export interface CompactionArtifactReference {
  id: string;
  citation?: string;
  sourceToolName?: string;
}

export interface CompactionExternalInspectReference {
  action: string;
  path?: string;
  externalRef: string;
  sourceArtifactId?: string;
  sourceArtifactCitation?: string;
}

export interface CompactionManifest {
  artifacts: CompactionArtifactReference[];
  externalInspect: CompactionExternalInspectReference[];
}

/** Estimated context tokens the transcript currently occupies. */
export function estimateContextUsage(messages: AgentMessage[]): number {
  return messages.reduce((total, message) => total + estimateTokens(message), 0);
}

/**
 * Format a manual-compaction completion summary comparing context load before and
 * after the rewrite. When the active model exposes a context window the load is
 * shown as a percentage (the most actionable signal for the user); otherwise the
 * raw estimated-token counts are used. Pure so it can be unit-tested without UI.
 */
export function formatCompactionSummary(stats: {
  beforeTokens: number;
  afterTokens: number;
  contextWindow: number;
}): string {
  const before = Math.round(stats.beforeTokens);
  const after = Math.round(stats.afterTokens);
  if (stats.contextWindow > 0) {
    const beforePct = Math.round((stats.beforeTokens / stats.contextWindow) * 100);
    const afterPct = Math.round((stats.afterTokens / stats.contextWindow) * 100);
    return `Compacted. Context load ${beforePct}% → ${afterPct}% (${before.toLocaleString()} → ${after.toLocaleString()} estimated tokens).`;
  }
  return `Compacted. ${before.toLocaleString()} → ${after.toLocaleString()} estimated tokens.`;
}

/**
 * Decide whether and how to compact. Returns `null` when compaction is disabled,
 * the window is unknown, the transcript is still under threshold, or there aren't
 * at least two user turns to split (one to summarize, one to keep).
 *
 * The cut point is always a user-message boundary, so assistant/tool-result pairs
 * are never orphaned and the retained messages remain a valid model context.
 */
export function planCompaction(
  messages: AgentMessage[],
  contextWindow: number,
  config: CompactionConfig,
): CompactionPlan | null {
  if (!config.enabled || contextWindow <= 0) return null;
  const tokensBefore = estimateContextUsage(messages);
  if (tokensBefore <= contextWindow * config.thresholdFraction) return null;

  const userIndices = messages.flatMap((message, index) => (message.role === "user" ? [index] : []));
  // Need a turn to summarize (index 0) and at least one later turn to keep.
  if (userIndices.length < 2) return null;

  const keepBudget = Math.max(0, contextWindow * config.keepFraction);
  // Suffix sums of per-message token estimates, so each candidate's kept-token
  // total is an O(1) lookup (keeps the whole scan O(N), not O(N²)).
  const suffixTokens = new Array<number>(messages.length + 1);
  suffixTokens[messages.length] = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    suffixTokens[i] = suffixTokens[i + 1] + estimateTokens(messages[i]);
  }
  // Candidate cut points are user boundaries after the first turn. Pick the
  // earliest cut whose retained tokens fit the keep budget (i.e. retain as much
  // recent history as fits); fall back to keeping only the final turn.
  const candidates = userIndices.slice(1);
  let cut = candidates[candidates.length - 1];
  for (const candidate of candidates) {
    if (suffixTokens[candidate] <= keepBudget) {
      cut = candidate;
      break;
    }
  }

  const summarize = messages.slice(0, cut);
  const keep = messages.slice(cut);
  if (summarize.length === 0 || keep.length === 0) return null;
  return { summarize, keep, tokensBefore };
}

/**
 * Wrap a summary string as a user message that replaces compacted history. A user
 * message converts cleanly for every provider and reads to the model as prior
 * context; the marker makes it identifiable in the transcript and on reload.
 */
export function buildSummaryMessage(
  summary: string,
  timestamp: number,
  compactedUsage?: Usage,
  compactionManifest?: CompactionManifest,
): AgentMessage {
  const manifest = compactionManifest && hasCompactionManifestEntries(compactionManifest) ? compactionManifest : undefined;
  const summaryWithManifest = appendCompactionManifest(summary, manifest);
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `Earlier conversation was summarized to save context:\n\n<conversation-summary>\n${summaryWithManifest}\n</conversation-summary>`,
      },
    ],
    timestamp,
    // Carried on the message (not just in memory) so the dropped turns' usage
    // survives JSONL reload and conversation rewind. See AgentService.getSessionUsage.
    ...(compactedUsage ? { compactedUsage } : {}),
    ...(manifest ? { compactionManifest: manifest } : {}),
  } as AgentMessage;
}

/** Usage of the turns folded into a summary message, if recorded. */
export function getCompactedUsage(message: AgentMessage): Usage | undefined {
  if (!isSummaryMessage(message)) return undefined;
  return (message as { compactedUsage?: Usage }).compactedUsage ?? undefined;
}

export function getCompactionManifest(message: AgentMessage): CompactionManifest | undefined {
  if (!isSummaryMessage(message)) return undefined;
  const manifest = (message as { compactionManifest?: CompactionManifest }).compactionManifest;
  return manifest && hasCompactionManifestEntries(manifest) ? manifest : undefined;
}

export function collectCompactionManifest(messages: AgentMessage[]): CompactionManifest {
  const artifacts = new Map<string, CompactionArtifactReference>();
  const externalInspect = new Map<string, CompactionExternalInspectReference>();

  for (const message of messages) {
    mergeCompactionManifest({ artifacts, externalInspect }, getCompactionManifest(message));
    collectMessageManifest({ artifacts, externalInspect }, message);
  }

  return {
    artifacts: [...artifacts.values()],
    externalInspect: [...externalInspect.values()],
  };
}

/** True when a message is a compaction summary produced by {@link buildSummaryMessage}. */
export function isSummaryMessage(message: AgentMessage): boolean {
  if (message.role !== "user") return false;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (block) =>
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string" &&
      (block as { text: string }).text.includes("<conversation-summary>"),
  );
}

function appendCompactionManifest(summary: string, manifest: CompactionManifest | undefined): string {
  const trimmed = summary.trim();
  if (!manifest) return trimmed;
  const manifestText = formatCompactionManifestMarkdown(manifest);
  return manifestText ? `${trimmed}\n\n${manifestText}` : trimmed;
}

function formatCompactionManifestMarkdown(manifest: CompactionManifest): string {
  const lines: string[] = [];
  if (manifest.artifacts.length > 0) {
    lines.push("## Preserved Artifact References");
    for (const artifact of manifest.artifacts) {
      const citation = artifact.citation ?? `artifact:${artifact.id}`;
      const source = artifact.sourceToolName ? ` (source tool: ${artifact.sourceToolName})` : "";
      lines.push(`- ${citation}${source}`);
    }
  }
  if (manifest.externalInspect.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("## Preserved External Inspect Cache");
    for (const entry of manifest.externalInspect) {
      const artifact = entry.sourceArtifactCitation ? `; artifact: ${entry.sourceArtifactCitation}` : "";
      lines.push(`- ${entry.action} ${entry.externalRef}${artifact}`);
    }
  }
  return lines.join("\n");
}

function hasCompactionManifestEntries(manifest: CompactionManifest): boolean {
  return manifest.artifacts.length > 0 || manifest.externalInspect.length > 0;
}

function mergeCompactionManifest(
  target: {
    artifacts: Map<string, CompactionArtifactReference>;
    externalInspect: Map<string, CompactionExternalInspectReference>;
  },
  manifest: CompactionManifest | undefined,
): void {
  if (!manifest) return;
  for (const artifact of manifest.artifacts) addArtifactReference(target.artifacts, artifact);
  for (const entry of manifest.externalInspect) addExternalInspectReference(target.externalInspect, entry);
}

function collectMessageManifest(
  target: {
    artifacts: Map<string, CompactionArtifactReference>;
    externalInspect: Map<string, CompactionExternalInspectReference>;
  },
  message: AgentMessage,
): void {
  const record = message as unknown as Record<string, unknown>;
  const details = record.details && typeof record.details === "object" ? (record.details as Record<string, unknown>) : {};
  const toolName = typeof record.toolName === "string" ? record.toolName : undefined;
  const sourceArtifactId = stringValue(details.sourceArtifactId) ?? stringValue(details.artifactId);
  const sourceArtifactCitation = stringValue(details.sourceArtifactCitation);
  if (sourceArtifactId) {
    addArtifactReference(target.artifacts, {
      id: sourceArtifactId,
      citation: sourceArtifactCitation,
      sourceToolName: toolName,
    });
  }
  for (const id of collectArtifactIdsFromText(messageContentText(message))) {
    addArtifactReference(target.artifacts, { id, sourceToolName: toolName });
  }
  if (toolName === "external_inspect") {
    const action = stringValue(details.action);
    const externalRef = stringValue(details.externalRef);
    if (action && externalRef) {
      addExternalInspectReference(target.externalInspect, {
        action,
        path: stringValue(details.path),
        externalRef,
        sourceArtifactId,
        sourceArtifactCitation,
      });
    }
  }
}

function addArtifactReference(
  artifacts: Map<string, CompactionArtifactReference>,
  artifact: CompactionArtifactReference,
): void {
  const existing = artifacts.get(artifact.id);
  artifacts.set(artifact.id, {
    id: artifact.id,
    citation: artifact.citation ?? existing?.citation,
    sourceToolName: artifact.sourceToolName ?? existing?.sourceToolName,
  });
}

function addExternalInspectReference(
  refs: Map<string, CompactionExternalInspectReference>,
  entry: CompactionExternalInspectReference,
): void {
  const key = `${entry.action} ${entry.externalRef}`;
  const existing = refs.get(key);
  refs.set(key, {
    action: entry.action,
    path: entry.path ?? existing?.path,
    externalRef: entry.externalRef,
    sourceArtifactId: entry.sourceArtifactId ?? existing?.sourceArtifactId,
    sourceArtifactCitation: entry.sourceArtifactCitation ?? existing?.sourceArtifactCitation,
  });
}

function messageContentText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join("\n");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
