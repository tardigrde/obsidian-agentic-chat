// Adapted from lhr0909/pi-obsidian (Simon Liang), MIT License.
// https://github.com/lhr0909/pi-obsidian
import type { App, DataAdapter, Plugin } from "obsidian";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { normalizeFolderPath } from "../vault/path";
import {
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
  messageCount: number;
  firstMessage: string;
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
  private sessionFile: string | null = null;
  private entries: SessionEntry[] = [];
  private leafId: string | null = null;

  constructor(adapter: DataAdapter, sessionDir: string, cwd: string) {
    this.adapter = adapter;
    this.sessionDir = normalizeFolderPath(sessionDir, { allowPluginInternals: true });
    this.cwd = cwd;
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
    this.entries = [createSessionHeader(sessionId, this.cwd, timestamp)];
    this.leafId = null;
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
    return this.getActiveSessionInfo();
  }

  async listSessions(): Promise<SessionInfo[]> {
    await this.ensureSessionDirectory();
    const listing = await this.adapter.list(this.sessionDir);
    const sessionFiles = listing.files.filter((path) => path.endsWith(".jsonl"));
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
    if (this.sessionFile === sessionPath) {
      this.sessionFile = null;
      this.entries = [];
      this.leafId = null;
    }
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
    this.entries.push(entry);
    this.leafId = entry.id;
    await this.adapter.append(this.sessionFile, `${JSON.stringify(entry)}\n`);
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
