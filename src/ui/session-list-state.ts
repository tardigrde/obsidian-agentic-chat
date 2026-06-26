import type { SessionInfo } from "../session/session-manager";

export interface SessionRowState {
  session: SessionInfo;
  title: string;
  meta: string;
  active: boolean;
}

/** Substring filter over a session's display name and first message (case-insensitive). */
export function filterSessions(sessions: SessionInfo[], query: string): SessionInfo[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return sessions;
  return sessions.filter((session) => {
    const name = session.name?.trim() ?? "";
    // Guard against a nullish firstMessage so it never coerces to "undefined"
    // (which would otherwise match a search for "undef").
    const firstMessage = session.firstMessage?.trim() ?? "";
    return `${name}\n${firstMessage}`.toLowerCase().includes(needle);
  });
}

export function sessionRows(sessions: SessionInfo[], query: string, activePath: string | null): SessionRowState[] {
  return filterSessions(sessions, query).map((session) => ({
    session,
    title: sessionTitle(session),
    meta: `${session.messageCount} ${plural(session.messageCount, "message")} · ${formatWhen(session.updatedAt)}`,
    active: session.path === activePath,
  }));
}

export function emptySessionMessage(totalSessions: number): string {
  return totalSessions === 0 ? "No saved conversations yet." : "No conversations match your search.";
}

export function removeSessionByPath(sessions: SessionInfo[], path: string): SessionInfo[] {
  return sessions.filter((session) => session.path !== path);
}

/** The text prefilled when a row enters inline rename mode. */
export function sessionRenameDraft(session: SessionInfo): string {
  return session.name?.trim() || session.firstMessage.trim();
}

/**
 * Return the name to persist for a rename, or null when Enter/blur/Escape should
 * only leave edit mode. Empty string is meaningful: it clears an existing custom
 * name and falls back to the first prompt.
 */
export function resolveSessionRename(session: SessionInfo, rawName: string, save: boolean): string | null {
  if (!save) return null;
  const hadCustomName = !!session.name?.trim();
  const current = sessionRenameDraft(session);
  const next = rawName.trim();
  const changed = next !== current;
  const clearsCustomName = next.length === 0 && hadCustomName;
  return changed && (next.length > 0 || clearsCustomName) ? next : null;
}

export function applySessionRename(session: SessionInfo, name: string): SessionInfo {
  return { ...session, name: name.trim() || undefined };
}

export function sessionTitle(session: SessionInfo): string {
  const text = session.name?.trim() || session.firstMessage;
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > 80 ? `${single.slice(0, 80)}…` : single || "(empty conversation)";
}

export function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}
