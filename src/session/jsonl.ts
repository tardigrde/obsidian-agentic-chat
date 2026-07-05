// Adapted from lhr0909/pi-obsidian (Simon Liang), MIT License.
// https://github.com/lhr0909/pi-obsidian
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ActionAuditEvent } from "../agent/action-audit-log";
import type { FileCheckpoint } from "../agent/file-checkpoints";
import { healPlanTrackerState, type PlanTrackerState } from "../agent/plan-tracker";

export const CURRENT_SESSION_VERSION = 1;

export interface SessionHeaderEntry {
  type: "session";
  version: typeof CURRENT_SESSION_VERSION;
  id: string;
  timestamp: string;
  cwd: string;
  projectId?: string;
  projectName?: string;
}

export interface MessageSessionEntry {
  type: "message";
  id: string;
  parentId: string | null;
  timestamp: string;
  message: AgentMessage;
}

export interface ModelChangeSessionEntry {
  type: "model_change";
  id: string;
  parentId: string | null;
  timestamp: string;
  provider: string;
  modelId: string;
}

export interface ThinkingLevelChangeSessionEntry {
  type: "thinking_level_change";
  id: string;
  parentId: string | null;
  timestamp: string;
  thinkingLevel: ThinkingLevel;
}

export interface SessionInfoEntry {
  type: "session_info";
  id: string;
  parentId: string | null;
  timestamp: string;
  name?: string;
}

export interface ActionAuditSessionEntry {
  type: "action_audit";
  id: string;
  parentId: string | null;
  timestamp: string;
  event: ActionAuditEvent;
}

export interface FileCheckpointSessionEntry {
  type: "file_checkpoint";
  id: string;
  parentId: string | null;
  timestamp: string;
  checkpoint: FileCheckpoint;
}

export interface PlanTrackerSessionEntry {
  type: "plan_tracker";
  id: string;
  parentId: string | null;
  timestamp: string;
  state: PlanTrackerState | null;
}

export type SessionEntry =
  | SessionHeaderEntry
  | MessageSessionEntry
  | ModelChangeSessionEntry
  | ThinkingLevelChangeSessionEntry
  | SessionInfoEntry
  | ActionAuditSessionEntry
  | FileCheckpointSessionEntry
  | PlanTrackerSessionEntry;

export interface SessionContext {
  messages: AgentMessage[];
  model: { provider: string; modelId: string } | null;
  thinkingLevel: ThinkingLevel;
}

export function createSessionHeader(
  id: string,
  cwd: string,
  timestamp = new Date().toISOString(),
  scope: { projectId?: string; projectName?: string } = {},
): SessionHeaderEntry {
  const header: SessionHeaderEntry = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id,
    timestamp,
    cwd,
  };
  if (scope.projectId) header.projectId = scope.projectId;
  if (scope.projectName) header.projectName = scope.projectName;
  return header;
}

export function parseSessionEntries(content: string): SessionEntry[] {
  const entries: SessionEntry[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as SessionEntry);
    } catch {
      // Skip a corrupt line rather than losing the whole session, but log it so
      // silent data loss (e.g. a partially-flushed append) is at least visible.
      console.warn("Agentic chat: skipping unparseable session entry.");
    }
  }
  return entries;
}

export function serializeSessionEntries(entries: SessionEntry[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

/** Rebuild the resumable transcript by walking the parent chain to `leafId`. */
export function buildSessionContext(entries: SessionEntry[], leafId?: string | null): SessionContext {
  const byId = indexEntries(entries);
  const path = getEntryPath(entries, byId, leafId);
  let model: SessionContext["model"] = null;
  let thinkingLevel: ThinkingLevel = "off";
  const messages: AgentMessage[] = [];

  for (const entry of path) {
    if (entry.type === "message") {
      messages.push(entry.message);
      if (entry.message.role === "assistant") {
        model = { provider: entry.message.provider, modelId: entry.message.model };
      }
    }
    if (entry.type === "model_change") model = { provider: entry.provider, modelId: entry.modelId };
    if (entry.type === "thinking_level_change") thinkingLevel = entry.thinkingLevel;
  }
  return { messages, model, thinkingLevel };
}

export function getLatestPlanTrackerState(entries: SessionEntry[], leafId?: string | null): PlanTrackerState | null {
  const byId = indexEntries(entries);
  const path = getEntryPath(entries, byId, leafId);
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const entry = path[index];
    if (entry?.type === "plan_tracker") return healPlanTrackerState(entry.state);
  }
  return null;
}

export function getLastLeafId(entries: SessionEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry && entry.type !== "session") return entry.id;
  }
  return null;
}

export function createEntryId(existingEntries: SessionEntry[]): string {
  const existingIds = new Set(existingEntries.filter((entry) => entry.type !== "session").map((entry) => entry.id));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = createRandomId().slice(0, 8);
    if (!existingIds.has(id)) return id;
  }
  return createRandomId();
}

export function createSessionId(): string {
  return createRandomId();
}

type NonHeaderEntry = Exclude<SessionEntry, SessionHeaderEntry>;

function indexEntries(entries: SessionEntry[]): Map<string, NonHeaderEntry> {
  const byId = new Map<string, NonHeaderEntry>();
  for (const entry of entries) {
    if (entry.type !== "session") byId.set(entry.id, entry);
  }
  return byId;
}

function getEntryPath(entries: SessionEntry[], byId: Map<string, NonHeaderEntry>, leafId?: string | null): NonHeaderEntry[] {
  if (leafId === null) return [];
  let leaf = leafId ? byId.get(leafId) : undefined;
  if (!leaf) leaf = getLastNonHeaderEntry(entries);
  if (!leaf) return [];
  const path: NonHeaderEntry[] = [];
  let current: NonHeaderEntry | undefined = leaf;
  while (current) {
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
}

function getLastNonHeaderEntry(entries: SessionEntry[]): NonHeaderEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry && entry.type !== "session") return entry;
  }
  return undefined;
}

function createRandomId(): string {
  return window.crypto?.randomUUID?.() ?? Math.random().toString(16).slice(2);
}
