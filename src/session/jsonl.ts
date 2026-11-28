// Adapted from lhr0909/pi-obsidian (Simon Liang), MIT License.
// https://github.com/lhr0909/pi-obsidian
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ActionAuditEvent } from "../agent/action-audit-types";
import type { FileCheckpoint } from "../agent/checkpoint-types";

export const CURRENT_SESSION_VERSION = 1;

/** A session written by a newer build cannot be read safely; never rewrite it. */
export class SessionVersionError extends Error {
  constructor(readonly version: number) {
    super(
      `This conversation uses session format ${version} from a newer version of Agentic Chat, but this build supports ${CURRENT_SESSION_VERSION}. ` +
        "Update the plugin to open it. The file was left unchanged.",
    );
    this.name = "SessionVersionError";
  }
}

/**
 * Version of a parsed header. Files from before versioning are version 1: their
 * shape is the current one, and the migration hook below starts from there.
 */
export function sessionHeaderVersion(header: SessionHeaderEntry | undefined): number {
  if (!header || typeof header.version !== "number" || !Number.isFinite(header.version)) {
    // Pre-versioning files are format 1, not whatever the current build uses:
    // when the format advances, their migration must still run from step 1.
    return 1;
  }
  return Math.trunc(header.version);
}

/** Throw before any read that could lead to a rewrite when the file is newer. */
export function assertSessionVersion(header: SessionHeaderEntry | undefined): void {
  const version = sessionHeaderVersion(header);
  if (version > CURRENT_SESSION_VERSION) throw new SessionVersionError(version);
}

type SessionMigration = (entries: SessionEntry[]) => SessionEntry[];

/**
 * Older formats migrate here, one step per version. Empty today: version 1 is
 * the first format, and the list is the hook for the next change.
 */
const SESSION_MIGRATIONS: Readonly<Record<number, SessionMigration>> = {};

/** Apply every migration between `fromVersion` and the current format. */
export function migrateSessionEntries(entries: SessionEntry[], fromVersion: number): SessionEntry[] {
  let migrated = entries;
  for (let version = fromVersion; version < CURRENT_SESSION_VERSION; version += 1) {
    const migration = SESSION_MIGRATIONS[version];
    if (migration) migrated = migration(migrated);
  }
  return migrated;
}

export interface SessionHeaderEntry {
  type: "session";
  version: typeof CURRENT_SESSION_VERSION;
  id: string;
  timestamp: string;
  cwd: string;
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

/**
 * The tab label: a short word the user gives the chat tab (double-click,
 * long-press, or the tab menu). It is not the session name, which stays the
 * auto name from the first prompt or a rename in history. The last entry wins;
 * no `label` clears it, and the tab shows its number again.
 */
export interface TabLabelSessionEntry {
  type: "tab_label";
  id: string;
  parentId: string | null;
  timestamp: string;
  label?: string;
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

/**
 * Append-only compaction record. The summary replaces every message before
 * `firstKeptEntryId` for the model; those messages stay in the file untouched.
 * The latest compaction on the active branch wins, so a rewind can append a
 * new record without deleting the history before the previous one.
 */
export interface CompactionSessionEntry {
  type: "compaction";
  id: string;
  parentId: string | null;
  timestamp: string;
  summary: AgentMessage;
  firstKeptEntryId: string;
}

/**
 * What `/doctor` saw (U4 #17): codes and counts only, redacted by
 * construction. The chaos miner reads it; the transcript ignores it.
 */
export interface DiagnosticsSessionEntry {
  type: "diagnostics";
  id: string;
  parentId: string | null;
  timestamp: string;
  summary: Record<string, unknown>;
}

/**
 * Legacy entry written by the removed plan tracker. Kept in the union so old
 * session files still parse and typecheck; the state is ignored on load.
 */
export interface LegacyPlanTrackerSessionEntry {
  type: "plan_tracker";
  id: string;
  parentId: string | null;
  timestamp: string;
  state?: unknown;
}

export type SessionEntry =
  | SessionHeaderEntry
  | MessageSessionEntry
  | ModelChangeSessionEntry
  | ThinkingLevelChangeSessionEntry
  | SessionInfoEntry
  | TabLabelSessionEntry
  | ActionAuditSessionEntry
  | FileCheckpointSessionEntry
  | CompactionSessionEntry
  | DiagnosticsSessionEntry
  | LegacyPlanTrackerSessionEntry;

export interface SessionContext {
  messages: AgentMessage[];
  model: { provider: string; modelId: string } | null;
  thinkingLevel: ThinkingLevel;
}

export function createSessionHeader(
  id: string,
  cwd: string,
  timestamp = new Date().toISOString(),
): SessionHeaderEntry {
  return {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id,
    timestamp,
    cwd,
  };
}

export function parseSessionEntries(content: string): SessionEntry[] {
  const entries: SessionEntry[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as SessionEntry);
    } catch {
      // Skip a corrupt line; log it so silent data loss stays visible.
      console.warn("Agentic chat: skipping unparseable session entry.");
    }
  }
  return entries;
}

export function serializeSessionEntries(entries: SessionEntry[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

/**
 * One entry id per message the model sees. `null` is the synthetic summary
 * message that lives on the latest compaction record rather than in a message
 * entry. The latest compaction on the branch replaces everything before its
 * `firstKeptEntryId`, while the older bytes stay in the file.
 */
export function getContextMessageEntryIds(
  entries: SessionEntry[],
  leafId?: string | null,
): Array<string | null> {
  const path = getEntryPath(entries, indexEntries(entries), leafId);
  let latestCompaction = -1;
  for (let index = 0; index < path.length; index += 1) {
    if (path[index]?.type === "compaction") latestCompaction = index;
  }
  if (latestCompaction < 0) {
    return path.flatMap((entry) => (entry.type === "message" ? [entry.id] : []));
  }
  const compaction = path[latestCompaction] as CompactionSessionEntry;
  const keptIndex = path.findIndex(
    (entry, index) => index < latestCompaction && entry.id === compaction.firstKeptEntryId,
  );
  const start = keptIndex >= 0 ? keptIndex : latestCompaction;
  const ids: Array<string | null> = [null];
  for (let index = start; index < path.length; index += 1) {
    if (index === latestCompaction) continue;
    const entry = path[index];
    if (entry?.type === "message") ids.push(entry.id);
  }
  return ids;
}

/** The entries on the active branch, oldest first (header excluded). */
export function getSessionPath(
  entries: SessionEntry[],
  leafId?: string | null,
): Array<Exclude<SessionEntry, SessionHeaderEntry>> {
  return getEntryPath(entries, indexEntries(entries), leafId);
}

/** The latest compaction record on the active branch, if any. */
export function getLastCompactionEntry(
  entries: SessionEntry[],
  leafId?: string | null,
): CompactionSessionEntry | undefined {
  const path = getEntryPath(entries, indexEntries(entries), leafId);
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const entry = path[index];
    if (entry?.type === "compaction") return entry;
  }
  return undefined;
}

/** Rebuild the resumable transcript by walking the parent chain to `leafId`. */
export function buildSessionContext(entries: SessionEntry[], leafId?: string | null): SessionContext {
  const byId = indexEntries(entries);
  const path = getEntryPath(entries, byId, leafId);
  let model: SessionContext["model"] = null;
  let thinkingLevel: ThinkingLevel = "off";
  let summary: AgentMessage | undefined;

  for (const entry of path) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      model = { provider: entry.message.provider, modelId: entry.message.model };
    }
    if (entry.type === "model_change") model = { provider: entry.provider, modelId: entry.modelId };
    if (entry.type === "thinking_level_change") thinkingLevel = entry.thinkingLevel;
  }
  const messages: AgentMessage[] = [];
  for (const id of getContextMessageEntryIds(entries, leafId)) {
    if (id === null) {
      if (!summary) {
        const compaction = getLastCompactionEntry(entries, leafId);
        summary = compaction?.summary;
      }
      if (summary) messages.push(summary);
      continue;
    }
    const entry = byId.get(id);
    if (entry?.type === "message") messages.push(entry.message);
  }
  return { messages, model, thinkingLevel };
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
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
