// Adapted from lhr0909/pi-obsidian (Simon Liang), MIT License.
// https://github.com/lhr0909/pi-obsidian
import type { App, DataAdapter, Plugin } from "obsidian";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { collectArtifactIdsFromMessages } from "../artifacts/artifact-references";
import type { ActionAuditEvent } from "../agent/action-audit-log";
import type { FileCheckpoint } from "../agent/file-checkpoints";
import type { UndoEntry } from "../agent/undo";
import type { PlanTrackerState } from "../agent/plan-tracker";
import { normalizeFolderPath } from "../vault/path";
import {
  type ActionAuditSessionEntry,
  type FileCheckpointSessionEntry,
  buildSessionContext,
  createEntryId,
  createSessionHeader,
  createSessionId,
  getLastLeafId,
  getLatestPlanTrackerState,
  parseSessionEntries,
  serializeSessionEntries,
  type MessageSessionEntry,
  type ModelChangeSessionEntry,
  type PlanTrackerSessionEntry,
  type SessionContext,
  type SessionEntry,
  type SessionHeaderEntry,
  type SessionInfoEntry,
  type ThinkingLevelChangeSessionEntry,
} from "./jsonl";

export interface SessionDefaults {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
}

export interface SessionInfo {
  id: string;
  path: string;
  createdAt: string;
  updatedAt: string;
  name?: string;
  projectId?: string;
  projectName?: string;
  messageCount: number;
  firstMessage: string;
}

export interface SessionScope {
  projectId?: string;
  projectName?: string;
}

interface SessionFileInfo extends SessionInfo {
  modifiedTime: number;
}

/**
 * Append-only JSONL conversation store under the plugin folder. Uses the vault
 * `DataAdapter` so it works on desktop and mobile without Node fs.
 */
export class ObsidianSessionManager {
  private readonly adapter: DataAdapter;
  private readonly sessionDir: string;
  private readonly cwd: string;
  private readonly scopeProvider?: () => SessionScope | undefined;
  private sessionFile: string | null = null;
  private entries: SessionEntry[] = [];
  private leafId: string | null = null;
  /** Paths whose first full-body checkpoint has already been written this
   * session. Subsequent checkpoints for the same path are slimmed to
   * `beforeSummary` to keep the JSONL bounded for long editing sessions. */
  private fullCheckpointPaths = new Set<string>();

  constructor(
    adapter: DataAdapter,
    sessionDir: string,
    cwd: string,
    scopeProvider?: () => SessionScope | undefined,
  ) {
    this.adapter = adapter;
    this.sessionDir = normalizeFolderPath(sessionDir, { allowPluginInternals: true });
    this.cwd = cwd;
    this.scopeProvider = scopeProvider;
  }

  static forPlugin(
    app: App,
    plugin: Plugin,
    scopeProvider?: () => SessionScope | undefined,
  ): ObsidianSessionManager {
    return new ObsidianSessionManager(
      app.vault.adapter,
      getPluginSessionDir(app, plugin),
      `obsidian-vault:${app.vault.getName()}`,
      scopeProvider,
    );
  }

  async createSession(defaults: SessionDefaults): Promise<SessionInfo> {
    await this.ensureSessionDirectory();
    const sessionId = createSessionId();
    const timestamp = new Date().toISOString();
    const fileTimestamp = timestamp.replace(/[:.]/g, "-");
    this.sessionFile = `${this.sessionDir}/${fileTimestamp}_${sessionId}.jsonl`;
    this.entries = [createSessionHeader(sessionId, this.cwd, timestamp, this.currentScope())];
    this.leafId = null;
    this.fullCheckpointPaths = new Set();
    await this.adapter.write(this.sessionFile, serializeSessionEntries(this.entries));
    await this.appendModelChange(defaults.provider, defaults.modelId);
    await this.appendThinkingLevelChange(defaults.thinkingLevel);
    return this.getActiveSessionInfo();
  }

  async continueRecentSession(defaults: SessionDefaults): Promise<SessionInfo> {
    const sessions = await this.listSessions();
    if (sessions[0]) {
      await this.loadSession(sessions[0].path);
      return this.getActiveSessionInfo();
    }
    return this.createSession(defaults);
  }

  async loadSession(path: string): Promise<SessionInfo> {
    const sessionPath = normalizeFolderPath(path, { allowPluginInternals: true });
    const content = await this.adapter.read(sessionPath);
    const entries = parseSessionEntries(content);
    if (entries[0]?.type !== "session") {
      throw new Error("Session file is missing a session header.");
    }
    this.sessionFile = sessionPath;
    this.entries = entries;
    this.leafId = getLastLeafId(entries);
    this.fullCheckpointPaths = new Set();
    return this.getActiveSessionInfo();
  }

  async listSessions(): Promise<SessionInfo[]> {
    await this.ensureSessionDirectory();
    const listing = await this.adapter.list(this.sessionDir);
    const sessionFiles = listing.files.filter((path) => path.endsWith(".jsonl"));
    const scope = this.currentScope();
    const sessions = await Promise.all(sessionFiles.map((path) => this.readSessionInfo(path)));
    return sessions
      .filter((session): session is SessionFileInfo => session !== null)
      .filter((session) => this.matchesScope(session, scope))
      .sort((left, right) => right.modifiedTime - left.modifiedTime)
      .map(({ modifiedTime: _modifiedTime, ...session }) => session);
  }

  async deleteSession(path: string): Promise<void> {
    const sessionPath = normalizeFolderPath(path, { allowPluginInternals: true });
    if (await this.adapter.exists(sessionPath)) {
      await this.adapter.remove(sessionPath);
    }
    if (this.sessionFile === sessionPath) {
      this.sessionFile = null;
      this.entries = [];
      this.leafId = null;
    }
  }

  async listReferencedArtifactIds(): Promise<Set<string>> {
    await this.ensureSessionDirectory();
    const listing = await this.adapter.list(this.sessionDir);
    const ids = new Set<string>();
    for (const path of listing.files.filter((file) => file.endsWith(".jsonl"))) {
      try {
        const entries = parseSessionEntries(await this.adapter.read(path));
        const messages = entries
          .filter((entry): entry is MessageSessionEntry => entry.type === "message")
          .map((entry) => entry.message);
        for (const id of collectArtifactIdsFromMessages(messages)) ids.add(id);
      } catch {
        // A broken session file should not block artifact cleanup for the rest.
      }
    }
    return ids;
  }

  async appendMessage(message: AgentMessage): Promise<string> {
    return this.appendEntry<MessageSessionEntry>({
      type: "message",
      id: createEntryId(this.entries),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      message,
    });
  }

  async appendModelChange(provider: string, modelId: string): Promise<string> {
    return this.appendEntry<ModelChangeSessionEntry>({
      type: "model_change",
      id: createEntryId(this.entries),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      provider,
      modelId,
    });
  }

  async appendThinkingLevelChange(thinkingLevel: ThinkingLevel): Promise<string> {
    return this.appendEntry<ThinkingLevelChangeSessionEntry>({
      type: "thinking_level_change",
      id: createEntryId(this.entries),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      thinkingLevel,
    });
  }

  async appendSessionName(name: string | undefined): Promise<string> {
    return this.appendEntry<SessionInfoEntry>({
      type: "session_info",
      id: createEntryId(this.entries),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      name,
    });
  }

  async appendActionAuditEvent(event: ActionAuditEvent): Promise<string> {
    return this.appendEntry<ActionAuditSessionEntry>({
      type: "action_audit",
      id: createEntryId(this.entries),
      parentId: this.leafId,
      timestamp: event.timestamp,
      event,
    });
  }

  async appendFileCheckpoint(checkpoint: FileCheckpoint): Promise<string> {
    return this.appendEntry<FileCheckpointSessionEntry>({
      type: "file_checkpoint",
      id: createEntryId(this.entries),
      parentId: this.leafId,
      timestamp: checkpoint.createdAt,
      checkpoint: slimCheckpoint(checkpoint, this.fullCheckpointPaths),
    });
  }

  async appendPlanTracker(state: PlanTrackerState | null): Promise<string> {
    return this.appendEntry<PlanTrackerSessionEntry>({
      type: "plan_tracker",
      id: createEntryId(this.entries),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      state,
    });
  }

  /**
   * Rename any session by path — the active one in memory, or another on disk by
   * appending a `session_info` entry to its file.
   */
  async renameSession(path: string, name: string | undefined): Promise<void> {
    const sessionPath = normalizeFolderPath(path, { allowPluginInternals: true });
    const trimmed = name?.trim() || undefined;
    if (this.sessionFile === sessionPath) {
      await this.appendSessionName(trimmed);
      return;
    }
    const content = await this.adapter.read(sessionPath);
    const entries = parseSessionEntries(content);
    if (entries[0]?.type !== "session") throw new Error("Session file is missing a session header.");
    const entry: SessionInfoEntry = {
      type: "session_info",
      id: createEntryId(entries),
      parentId: getLastLeafId(entries),
      timestamp: new Date().toISOString(),
      name: trimmed,
    };
    await this.adapter.append(sessionPath, `${JSON.stringify(entry)}\n`);
  }

  /**
   * Replace the active session's transcript with `messages`, rewriting the file
   * to a fresh linear chain (preserving the header + active model/thinking level).
   * Used by prompt editing to rewind a conversation to an earlier turn.
   */
  async rewriteMessages(messages: AgentMessage[]): Promise<void> {
    if (!this.sessionFile) throw new Error("No active session.");
    const header = this.entries[0];
    if (!header || header.type !== "session") throw new Error("Session file is missing a session header.");
    const sessionName = getSessionName(this.entries);
    const planTracker = this.getActivePlanTracker();
    const context = this.buildSessionContext();
    const rebuilt: SessionEntry[] = [header];
    let parentId: string | null = null;
    const push = (entry: Exclude<SessionEntry, SessionHeaderEntry>): void => {
      rebuilt.push(entry);
      parentId = entry.id;
    };
    for (const message of messages) {
      push({
        type: "message",
        id: createEntryId(rebuilt),
        parentId,
        timestamp: new Date().toISOString(),
        message,
      });
    }
    // Re-append session metadata after the rewritten transcript. Assistant
    // messages also carry provider/model ids, so trailing metadata preserves the
    // active config when a rewind keeps an older assistant message.
    if (context.model) {
      push({
        type: "model_change",
        id: createEntryId(rebuilt),
        parentId,
        timestamp: new Date().toISOString(),
        provider: context.model.provider,
        modelId: context.model.modelId,
      });
    }
    push({
      type: "thinking_level_change",
      id: createEntryId(rebuilt),
      parentId,
      timestamp: new Date().toISOString(),
      thinkingLevel: context.thinkingLevel,
    });
    // Carry over a custom session name so prompt editing doesn't silently lose it.
    if (sessionName) {
      push({
        type: "session_info",
        id: createEntryId(rebuilt),
        parentId,
        timestamp: new Date().toISOString(),
        name: sessionName,
      });
    }
    if (planTracker) {
      push({
        type: "plan_tracker",
        id: createEntryId(rebuilt),
        parentId,
        timestamp: new Date().toISOString(),
        state: planTracker,
      });
    }
    await this.adapter.write(this.sessionFile, serializeSessionEntries(rebuilt));
    this.entries = rebuilt;
    this.leafId = parentId;
  }

  buildSessionContext(): SessionContext {
    return buildSessionContext(this.entries, this.leafId);
  }

  getActivePlanTracker(): PlanTrackerState | null {
    return getLatestPlanTrackerState(this.entries, this.leafId);
  }

  hasActiveSession(): boolean {
    return this.sessionFile !== null;
  }

  getActiveSessionInfo(): SessionInfo {
    if (!this.sessionFile) throw new Error("No active session.");
    return summarizeSession(this.sessionFile, this.entries, Date.now());
  }

  getActiveSessionPath(): string | null {
    return this.sessionFile;
  }

  /** Append model/thinking-level changes when the active config drifts from the session. */
  async ensureConfiguration(defaults: SessionDefaults): Promise<void> {
    const context = this.buildSessionContext();
    if (context.model?.provider !== defaults.provider || context.model.modelId !== defaults.modelId) {
      await this.appendModelChange(defaults.provider, defaults.modelId);
    }
    if (context.thinkingLevel !== defaults.thinkingLevel) {
      await this.appendThinkingLevelChange(defaults.thinkingLevel);
    }
  }

  private async appendEntry<TEntry extends Exclude<SessionEntry, { type: "session" }>>(entry: TEntry): Promise<string> {
    if (!this.sessionFile) throw new Error("No active session.");
    // Write to disk first: if the append fails, the in-memory entries/leafId stay
    // consistent with what's actually persisted instead of drifting ahead of it.
    await this.adapter.append(this.sessionFile, `${JSON.stringify(entry)}\n`);
    this.entries.push(entry);
    this.leafId = entry.id;
    return entry.id;
  }

  private async ensureSessionDirectory(): Promise<void> {
    let current = "";
    for (const segment of this.sessionDir.split("/")) {
      current = current ? `${current}/${segment}` : segment;
      if (!(await this.adapter.exists(current))) {
        await this.adapter.mkdir(current);
      }
    }
  }

  private async readSessionInfo(path: string): Promise<SessionFileInfo | null> {
    try {
      const [content, stat] = await Promise.all([this.adapter.read(path), this.adapter.stat(path)]);
      const entries = parseSessionEntries(content);
      if (entries[0]?.type !== "session") return null;
      const modifiedTime = getSessionModifiedTime(entries, stat?.mtime ?? Date.now());
      return { ...summarizeSession(path, entries, modifiedTime), modifiedTime };
    } catch {
      return null;
    }
  }

  private currentScope(): SessionScope | undefined {
    return this.scopeProvider?.();
  }

  private matchesScope(session: SessionInfo, scope: SessionScope | undefined): boolean {
    if (!this.scopeProvider) return true;
    const projectId = scope?.projectId?.trim() || "";
    return projectId ? session.projectId === projectId : !session.projectId;
  }
}

export function getPluginSessionDir(app: App, plugin: Plugin): string {
  const pluginDir = plugin.manifest.dir ?? `${app.vault.configDir}/plugins/${plugin.manifest.id}`;
  return `${pluginDir}/sessions`;
}

function summarizeSession(path: string, entries: SessionEntry[], modifiedTime: number): SessionInfo {
  const header = entries[0];
  if (!header || header.type !== "session") {
    throw new Error("Session entries must start with a session header.");
  }
  const messageEntries = entries.filter((entry): entry is MessageSessionEntry => entry.type === "message");
  return {
    id: header.id,
    path,
    createdAt: header.timestamp,
    updatedAt: new Date(getSessionModifiedTime(entries, modifiedTime)).toISOString(),
    name: getSessionName(entries),
    projectId: header.projectId,
    projectName: header.projectName,
    messageCount: messageEntries.length,
    firstMessage: getFirstUserMessage(messageEntries) || "(no messages)",
  };
}

function getSessionName(entries: SessionEntry[]): string | undefined {
  let name: string | undefined;
  for (const entry of entries) {
    if (entry.type === "session_info") name = entry.name?.trim() || undefined;
  }
  return name;
}

function getFirstUserMessage(entries: MessageSessionEntry[]): string | undefined {
  for (const entry of entries) {
    if (entry.message.role === "user") return extractMessageText(entry.message);
  }
  return undefined;
}

function getSessionModifiedTime(entries: SessionEntry[], fallback: number): number {
  let modifiedTime = fallback;
  for (const entry of entries) {
    if (entry.type === "message") {
      const ts = entry.message.timestamp;
      if (typeof ts === "number" && !Number.isNaN(ts)) modifiedTime = Math.max(modifiedTime, ts);
      continue;
    }
    if (entry.type !== "session" && entry.timestamp) {
      const parsed = new Date(entry.timestamp).getTime();
      if (!Number.isNaN(parsed)) modifiedTime = Math.max(modifiedTime, parsed);
    }
  }
  return modifiedTime;
}

/**
 * Derive a short session title from the first user prompt. Strips any attachment
 * `<context>…</context>` preamble, collapses whitespace, and trims to a handful of
 * words. Deterministic (no model call) — see ROADMAP for the model-based upgrade.
 */
export function deriveAutoName(firstMessage: string): string | undefined {
  const withoutContext = firstMessage.replace(/^<context>[\s\S]*?<\/context>\s*/, "");
  const slashStripped = withoutContext.replace(/^\/(?:skill|template)\s+/, "");
  const condensed = slashStripped.replace(/\s+/g, " ").trim();
  if (!condensed) return undefined;
  const words = condensed.split(" ").slice(0, 8).join(" ");
  let capped = words;
  if (capped.length > 60) {
    capped = capped.slice(0, 60);
    const lastSpace = capped.lastIndexOf(" ");
    capped = `${(lastSpace > 0 ? capped.slice(0, lastSpace) : capped).trimEnd()}…`;
  }
  const cleaned = capped.replace(/[.,;:!?]+$/, "");
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function extractMessageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text",
    )
    .map((block) => block.text)
    .join("\n");
}

/**
 * Drop the full `before` body from every entry after the first checkpoint for a
 * given path, keeping only `beforeSummary` (hash + length). The in-memory
 * `FileCheckpoint` is left untouched so `/undo` still has the full body; only
 * the JSONL serialization is slimmed. The cast on the slimmed entry is local:
 * the on-disk type has an optional `before` for the same reason (slimmed log
 * entries omit the body) but the in-memory `UndoEntry` keeps it required.
 */
function slimCheckpoint(
  checkpoint: FileCheckpoint,
  fullCheckpointPaths: Set<string>,
): FileCheckpoint {
  const slimmedEntries = [...checkpoint.entries];
  let mutated = false;
  for (let i = 0; i < slimmedEntries.length; i++) {
    const entry = slimmedEntries[i];
    if (!entry) continue;
    if (entry.kind === "rename" || entry.kind === "delete_folder") continue;
    if (fullCheckpointPaths.has(entry.path) && entry.before !== undefined && entry.before !== null) {
      const { before: _before, ...rest } = entry;
      slimmedEntries[i] = rest as UndoEntry;
      mutated = true;
      continue;
    }
    fullCheckpointPaths.add(entry.path);
  }
  if (!mutated) return checkpoint;
  return { ...checkpoint, entries: slimmedEntries };
}
