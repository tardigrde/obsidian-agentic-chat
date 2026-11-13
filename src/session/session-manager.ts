// Adapted from lhr0909/pi-obsidian (Simon Liang), MIT License.
// https://github.com/lhr0909/pi-obsidian
import type { App, DataAdapter, Plugin } from "obsidian";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { collectArtifactIdsFromMessages } from "../artifacts/artifact-references";
import type { ActionAuditEvent } from "../agent/action-audit-log";
import type { FileCheckpoint } from "../agent/file-checkpoints";
import type { UndoEntry } from "../agent/undo";
import { normalizeFolderPath } from "../vault/path";
import { ensureAdapterFolder, removeIfExists, renameOver } from "../vault/storage";
import {
  type ActionAuditSessionEntry,
  type FileCheckpointSessionEntry,
  buildSessionContext,
  createEntryId,
  createSessionHeader,
  createSessionId,
  getLastLeafId,
  parseSessionEntries,
  serializeSessionEntries,
  type MessageSessionEntry,
  type ModelChangeSessionEntry,
  type SessionContext,
  type SessionEntry,
  type SessionHeaderEntry,
  type SessionInfoEntry,
  type ThinkingLevelChangeSessionEntry,
} from "./jsonl";

const SESSION_TEMP_MARKER = ".tmp.";
const SESSION_BACKUP_SUFFIX = ".bak";

/** Temp and backup paths owned by an in-flight rewrite. */
interface SessionWriteOwnership {
  temps: Set<string>;
  backups: Set<string>;
}

/**
 * Owned by ObsidianSessionManager. Every chat tab builds its own manager over
 * the same vault adapter and session folder, so "is this temp/backup mine?"
 * must be answered across all of them, not per instance. Keyed by adapter so
 * separate vaults (and separate test adapters) never share entries.
 */
const sessionWriteOwnership = new WeakMap<DataAdapter, SessionWriteOwnership>();

function getSessionWriteOwnership(adapter: DataAdapter): SessionWriteOwnership {
  let ownership = sessionWriteOwnership.get(adapter);
  if (!ownership) {
    ownership = { temps: new Set(), backups: new Set() };
    sessionWriteOwnership.set(adapter, ownership);
  }
  return ownership;
}

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
  messageCount: number;
  firstMessage: string;
}

interface SessionFileInfo extends SessionInfo {
  modifiedTime: number;
}

export interface RewriteMessagesOptions {
  /** Session file the caller read before its long-running work started. */
  expectedPath?: string | null;
  /** Generation captured with {@link ObsidianSessionManager.getActiveSessionGeneration}. */
  expectedGeneration?: number;
}

export interface LoadSessionOptions {
  /** Session file the caller expects to still be active when the read lands. */
  expectedPath?: string | null;
  /** Generation captured with {@link ObsidianSessionManager.getActiveSessionGeneration}. */
  expectedGeneration?: number;
}

/**
 * Append-only JSONL conversation store under the plugin folder. Uses the vault
 * `DataAdapter` so it works on desktop and mobile without Node fs.
 */
export class ObsidianSessionManager {
  private readonly adapter: DataAdapter;
  private readonly sessionDir: string;
  private readonly cwd: string;
  private sessionFile: string | null = null;
  private entries: SessionEntry[] = [];
  private leafId: string | null = null;
  /** Bumped whenever the active session changes; guards awaits against swaps. */
  private sessionGeneration = 0;
  /** Paths whose first full-body checkpoint has already been written this
   * session. Subsequent checkpoints for the same path are slimmed to
   * `beforeSummary` to keep the JSONL bounded for long editing sessions. */
  private fullCheckpointPaths = new Set<string>();
  /** Temp files owned by an in-flight rewrite in any manager on this adapter;
   * stale cleanup must skip them. */
  private readonly pendingSessionTemps: Set<string>;
  /** Backups owned by an in-flight replace in any manager on this adapter;
   * reads must not restore them. */
  private readonly pendingSessionBackups: Set<string>;

  constructor(adapter: DataAdapter, sessionDir: string, cwd: string) {
    this.adapter = adapter;
    this.sessionDir = normalizeFolderPath(sessionDir, { allowPluginInternals: true });
    this.cwd = cwd;
    const ownership = getSessionWriteOwnership(adapter);
    this.pendingSessionTemps = ownership.temps;
    this.pendingSessionBackups = ownership.backups;
  }

  static forPlugin(app: App, plugin: Plugin): ObsidianSessionManager {
    return new ObsidianSessionManager(
      app.vault.adapter,
      getPluginSessionDir(app, plugin),
      `obsidian-vault:${app.vault.getName()}`,
    );
  }

  async createSession(defaults: SessionDefaults): Promise<SessionInfo> {
    await this.ensureSessionDirectory();
    const sessionId = createSessionId();
    const timestamp = new Date().toISOString();
    const fileTimestamp = timestamp.replace(/[:.]/g, "-");
    this.sessionFile = `${this.sessionDir}/${fileTimestamp}_${sessionId}.jsonl`;
    this.sessionGeneration += 1;
    this.entries = [createSessionHeader(sessionId, this.cwd, timestamp)];
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

  async loadSession(path: string, options: LoadSessionOptions = {}): Promise<SessionInfo> {
    const sessionPath = normalizeFolderPath(path, { allowPluginInternals: true });
    await this.cleanupStaleSessionTemps();
    const content = await this.readSessionContent(sessionPath);
    const entries = parseSessionEntries(content);
    if (entries[0]?.type !== "session") {
      throw new Error("Session file is missing a session header.");
    }
    if (
      (options.expectedPath !== undefined && this.sessionFile !== options.expectedPath) ||
      (options.expectedGeneration !== undefined && this.sessionGeneration !== options.expectedGeneration)
    ) {
      throw new Error("Session changed before it could be loaded.");
    }
    this.sessionFile = sessionPath;
    this.sessionGeneration += 1;
    this.entries = entries;
    this.leafId = getLastLeafId(entries);
    this.fullCheckpointPaths = new Set();
    return this.getActiveSessionInfo();
  }

  async listSessions(): Promise<SessionInfo[]> {
    await this.ensureSessionDirectory();
    const listing = await this.adapter.list(this.sessionDir);
    const sessionFiles = this.listSessionPaths(listing.files);
    const sessions = await Promise.all(sessionFiles.map((path) => this.readSessionInfo(path)));
    return sessions
      .filter((session): session is SessionFileInfo => session !== null)
      .sort((left, right) => right.modifiedTime - left.modifiedTime)
      .map(({ modifiedTime: _modifiedTime, ...session }) => session);
  }

  async deleteSession(path: string): Promise<void> {
    const sessionPath = normalizeFolderPath(path, { allowPluginInternals: true });
    if (await this.adapter.exists(sessionPath)) {
      await this.adapter.remove(sessionPath);
    }
    await removeIfExists(this.adapter, `${sessionPath}${SESSION_BACKUP_SUFFIX}`);
    if (this.sessionFile === sessionPath) {
      this.sessionFile = null;
      this.sessionGeneration += 1;
      this.entries = [];
      this.leafId = null;
    }
  }

  async listReferencedArtifactIds(): Promise<Set<string>> {
    await this.ensureSessionDirectory();
    const listing = await this.adapter.list(this.sessionDir);
    const ids = new Set<string>();
    for (const path of this.listSessionPaths(listing.files)) {
      try {
        const entries = parseSessionEntries(await this.readSessionContent(path));
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
   *
   * `options` binds the rewrite to the session that was active when a longer
   * operation, such as summarization, started. A swap before or during the
   * write makes the rewrite fail instead of corrupting the new session.
   */
  async rewriteMessages(messages: AgentMessage[], options: RewriteMessagesOptions = {}): Promise<void> {
    const sessionFile = this.sessionFile;
    if (!sessionFile) throw new Error("No active session.");
    const generation = this.sessionGeneration;
    if (options.expectedPath !== undefined && options.expectedPath !== sessionFile) {
      throw new Error("Session changed before the transcript rewrite could start.");
    }
    if (options.expectedGeneration !== undefined && options.expectedGeneration !== generation) {
      throw new Error("Session changed before the transcript rewrite could start.");
    }
    const header = this.entries[0];
    if (!header || header.type !== "session") throw new Error("Session file is missing a session header.");
    const sessionName = getSessionName(this.entries);
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
    await this.writeSessionFile(sessionFile, serializeSessionEntries(rebuilt));
    if (this.sessionFile !== sessionFile || this.sessionGeneration !== generation) {
      throw new Error("Session changed while rewriting the transcript.");
    }
    this.entries = rebuilt;
    this.leafId = parentId;
    // A successful rewrite is a new transcript revision. A compaction that read
    // the old revision must not treat its stale snapshot as current.
    this.sessionGeneration += 1;
  }

  buildSessionContext(): SessionContext {
    return buildSessionContext(this.entries, this.leafId);
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

  /** Bumped on every create/load/delete of the active session. */
  getActiveSessionGeneration(): number {
    return this.sessionGeneration;
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

  /**
   * Replace a session file through a temp file in the same folder, then rename.
   * A same-folder rename replaces the old file atomically on the desktop
   * filesystem, so a crash leaves either the old transcript or the new one.
   *
   * `DataAdapter.rename` does not promise to overwrite an existing file. If the
   * adapter refuses, keep the old bytes in `.bak` until the new file is in
   * place, then remove the backup. `readSessionContent` restores from `.bak`
   * when a crash lands between the remove and the rename.
   */
  private async writeSessionFile(sessionFile: string, content: string): Promise<void> {
    const tempPath = `${sessionFile}${SESSION_TEMP_MARKER}${createSessionId()}`;
    this.pendingSessionTemps.add(tempPath);
    try {
      await this.adapter.write(tempPath, content);
      await this.replaceSessionFile(tempPath, sessionFile);
    } catch (error) {
      await removeIfExists(this.adapter, tempPath);
      throw error;
    } finally {
      this.pendingSessionTemps.delete(tempPath);
    }
  }

  /** Rename the staged file into place, using a backup when overwrite is refused. */
  private async replaceSessionFile(tempPath: string, sessionFile: string): Promise<void> {
    await renameOver(this.adapter, tempPath, sessionFile, async () => {
      const backupPath = `${sessionFile}${SESSION_BACKUP_SUFFIX}`;
      this.pendingSessionBackups.add(backupPath);
      try {
        const previous = await this.adapter.read(sessionFile);
        await this.adapter.write(backupPath, previous);
        try {
          await this.adapter.remove(sessionFile);
          await this.adapter.rename(tempPath, sessionFile);
        } catch (error) {
          await this.restoreSessionFile(sessionFile, backupPath);
          throw error;
        }
        await removeIfExists(this.adapter, backupPath);
      } finally {
        this.pendingSessionBackups.delete(backupPath);
      }
    });
  }

  /** The session file's content when it exists and has a header, else null. */
  private async readIfValid(path: string): Promise<string | null> {
    try {
      const content = await this.adapter.read(path);
      return hasSessionHeader(content) ? content : null;
    } catch {
      return null;
    }
  }

  /** Put the old bytes back after a failed fallback replace. */
  private async restoreSessionFile(sessionFile: string, backupPath: string, force = false): Promise<void> {
    try {
      if (!force && (await this.adapter.exists(sessionFile))) {
        await removeIfExists(this.adapter, backupPath);
        return;
      }
      // Without a backup there is nothing to restore: never delete the file.
      if (!(await this.adapter.exists(backupPath))) return;
      if (await this.adapter.exists(sessionFile)) await this.adapter.remove(sessionFile);
      await this.adapter.rename(backupPath, sessionFile);
    } catch {
      // Keep the backup in place; the next load can try the restore again.
    }
  }

  /** Read a session, restoring `.bak` when the main file is missing or torn. */
  private async readSessionContent(path: string): Promise<string> {
    const backupPath = `${path}${SESSION_BACKUP_SUFFIX}`;
    let content: string | null = null;
    let readError: Error | undefined;
    try {
      content = await this.adapter.read(path);
      if (hasSessionHeader(content)) {
        if (!this.pendingSessionBackups.has(backupPath)) await removeIfExists(this.adapter, backupPath);
        return content;
      }
    } catch (error) {
      readError = error instanceof Error ? error : new Error(String(error));
    }
    if (!(await this.adapter.exists(backupPath))) {
      if (readError) throw readError;
      return content ?? "";
    }
    const backup = await this.adapter.read(backupPath);
    if (!hasSessionHeader(backup)) {
      if (readError) throw readError;
      return content ?? "";
    }
    if (this.pendingSessionBackups.has(backupPath)) {
      // A replace owns this backup until its rename finishes. Reading it is
      // safe, but do not restore it over the file the replace is landing.
      throw new Error("Session file is being replaced.");
    }
    // A replace in another tab can finish while this read awaited: its new
    // file is in place and it removed the backup. Use that file; restoring
    // the stale backup over it would delete the rewrite (#290 harness).
    const landed = await this.readIfValid(path);
    if (landed !== null) return landed;
    await this.restoreSessionFile(path, backupPath, true);
    return backup;
  }

  /** Include backup-only sessions so a crash-interrupted replace stays visible. */
  private listSessionPaths(files: string[]): string[] {
    const paths = new Set(files.filter(isSessionFilePath));
    for (const file of files) {
      if (!isSessionBackupPath(file)) continue;
      const sessionPath = file.slice(0, -SESSION_BACKUP_SUFFIX.length);
      if (!paths.has(sessionPath)) paths.add(sessionPath);
    }
    return [...paths];
  }

  /** Remove abandoned temp files left by an earlier crash. */
  private async cleanupStaleSessionTemps(): Promise<void> {
    let listing;
    try {
      listing = await this.adapter.list(this.sessionDir);
    } catch {
      return;
    }
    const stale = listing.files.filter(
      (path) => isSessionTempPath(path) && !this.pendingSessionTemps.has(path),
    );
    await Promise.all(stale.map((path) => removeIfExists(this.adapter, path)));
  }

  private async appendEntry<TEntry extends Exclude<SessionEntry, { type: "session" }>>(entry: TEntry): Promise<string> {
    const sessionFile = this.sessionFile;
    if (!sessionFile) throw new Error("No active session.");
    const generation = this.sessionGeneration;
    // Write to disk first: if the append fails, the in-memory entries/leafId stay
    // consistent with what's actually persisted instead of drifting ahead of it.
    await this.adapter.append(sessionFile, `${JSON.stringify(entry)}\n`);
    // A session swap can land while the append is in flight. The entry belongs
    // to the file we captured above; never splice it into the new session's
    // in-memory chain or leaf pointer.
    if (generation !== this.sessionGeneration || this.sessionFile !== sessionFile) return entry.id;
    this.entries.push(entry);
    this.leafId = entry.id;
    return entry.id;
  }

  private async ensureSessionDirectory(): Promise<void> {
    await ensureAdapterFolder(this.adapter, this.sessionDir);
    await this.cleanupStaleSessionTemps();
  }

  private async readSessionInfo(path: string): Promise<SessionFileInfo | null> {
    try {
      const content = await this.readSessionContent(path);
      const stat = await this.adapter.stat(path);
      const entries = parseSessionEntries(content);
      if (entries[0]?.type !== "session") return null;
      const modifiedTime = getSessionModifiedTime(entries, stat?.mtime ?? Date.now());
      return { ...summarizeSession(path, entries, modifiedTime), modifiedTime };
    } catch {
      return null;
    }
  }
}

export function getPluginSessionDir(app: App, plugin: Plugin): string {
  const pluginDir = plugin.manifest.dir ?? `${app.vault.configDir}/plugins/${plugin.manifest.id}`;
  return `${pluginDir}/sessions`;
}

function sessionFileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function isSessionTempPath(path: string): boolean {
  return sessionFileName(path).includes(`.jsonl${SESSION_TEMP_MARKER}`);
}

function isSessionBackupPath(path: string): boolean {
  return sessionFileName(path).endsWith(`.jsonl${SESSION_BACKUP_SUFFIX}`);
}

function isSessionFilePath(path: string): boolean {
  return sessionFileName(path).endsWith(".jsonl") && !isSessionTempPath(path);
}

function hasSessionHeader(content: string): boolean {
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      return (JSON.parse(line) as { type?: unknown }).type === "session";
    } catch {
      return false;
    }
  }
  return false;
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
