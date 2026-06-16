import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isSummaryMessage } from "../agent/compaction";
import { collectToolResults, messageText, toolCalls } from "../ui/message-content";
import type { SessionInfo } from "./session-manager";

/** Strip an attachment `<context>…</context>` preamble so exports read like the chat. */
const CONTEXT_PREAMBLE = /^<context>[\s\S]*?<\/context>\n\n/;

/** Default vault folder exported conversations are written into. */
export const EXPORT_FOLDER = "Agentic Chat Exports";

/**
 * Render a session transcript as a portable Markdown note: YAML frontmatter, then
 * one `## You` / `## Assistant` section per turn (tool calls listed compactly).
 * Pure — the caller handles vault IO.
 */
export function sessionToMarkdown(messages: AgentMessage[], info: SessionInfo | undefined): string {
  const title = info?.name?.trim() || "Agentic chat conversation";
  const lines: string[] = ["---", `title: ${yamlString(title)}`];
  if (info?.createdAt) lines.push(`created: ${info.createdAt}`);
  if (info?.updatedAt) lines.push(`updated: ${info.updatedAt}`);
  lines.push("source: agentic-chat", "---", "", `# ${title}`, "");

  const toolResults = collectToolResults(messages);
  for (const message of messages) {
    if (message.role === "user" && isSummaryMessage(message)) {
      const summary = messageText(message).trim();
      if (summary) lines.push("## Summary of earlier conversation", "", summary, "");
      continue;
    }
    if (message.role === "user") {
      const text = messageText(message).replace(CONTEXT_PREAMBLE, "").trim();
      if (text) lines.push("## You", "", text, "");
      continue;
    }
    if (message.role === "assistant") {
      const calls = toolCalls(message);
      const text = messageText(message).trim();
      if (calls.length === 0 && !text) continue;
      lines.push("## Assistant", "");
      for (const call of calls) {
        const errored = toolResults.get(call.id)?.isError ? " (error)" : "";
        lines.push(`- \`${call.name}\`${errored}`);
      }
      if (calls.length > 0) lines.push("");
      if (text) lines.push(text, "");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** Filename for an exported session: sanitized title + a UTC timestamp, `.md`. */
export function exportFileName(info: SessionInfo | undefined, now: number): string {
  const base = sanitizeFileName(info?.name?.trim() || "Agentic chat conversation");
  const stamp = new Date(now).toISOString().slice(0, 19).replace("T", " ").replace(/:/g, "-");
  return `${base} ${stamp}.md`;
}

/** Whether a transcript has any user/assistant turns worth exporting. */
export function hasExportableTurns(messages: AgentMessage[]): boolean {
  return messages.some((message) => message.role === "user" || message.role === "assistant");
}

/** Double-quote a YAML scalar, escaping backslashes, quotes, and control whitespace. */
function yamlString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

/** Drop characters illegal in vault file names, collapse whitespace, and cap length. */
function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();
  return cleaned || "Conversation";
}
