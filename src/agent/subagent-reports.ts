import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { UserMessage } from "@earendil-works/pi-ai";
import type { SubagentChildStatus, SubagentReport } from "../tools/subagent-tool";
import { wrapToolOutput } from "../tools/tool-output-wrapper";

/**
 * A background child's report reaches the parent as a user-role message (U5
 * #1). It is a plain user message, so the session file format does not change;
 * the opening tag marks it, so the UI renders it as an event, not as the
 * user's words, and the steering drain never puts it back in the composer.
 */
const OPENING = /^<subagent_report id="([^"]*)" agent="([^"]*)" status="([^"]*)" call="([^"]*)">\n/u;
const CLOSING = "\n</subagent_report>";

export interface ParsedSubagentReport {
  childId: string;
  agent: string;
  status: SubagentChildStatus["status"];
  toolCallId: string;
  /** The model-facing text, still wrapped as untrusted output. */
  body: string;
}

const attr = (value: string): string => value.replace(/["<>\n\r]/gu, " ").trim();

export function formatSubagentReport(report: SubagentReport): string {
  const status = report.details.children[0]?.status ?? "done";
  const header = `<subagent_report id="${attr(report.childId)}" agent="${attr(report.agent)}" status="${attr(status)}" call="${attr(report.toolCallId)}">`;
  // The body is the child's output: data from notes and the web, never instructions.
  return `${header}\n${wrapToolOutput(report.text, "subagent")}${CLOSING}`;
}

export function parseSubagentReport(text: string): ParsedSubagentReport | null {
  const match = OPENING.exec(text);
  if (!match || !text.endsWith(CLOSING)) return null;
  return {
    childId: match[1],
    agent: match[2],
    status: match[3] as SubagentChildStatus["status"],
    toolCallId: match[4],
    body: text.slice(match[0].length, text.length - CLOSING.length),
  };
}

export function messageText(message: AgentMessage): string {
  if (message.role !== "user") return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export function isSubagentReportMessage(message: AgentMessage): boolean {
  return message.role === "user" && parseSubagentReport(messageText(message)) !== null;
}

export function subagentReportMessage(report: SubagentReport): UserMessage {
  return { role: "user", content: [{ type: "text", text: formatSubagentReport(report) }], timestamp: Date.now() };
}

export interface SubagentReportDeliveryOptions {
  getAgent: () => Agent | undefined;
  isDisposed: () => boolean;
  /** True while a parent turn is being set up but `isStreaming` is not yet set. */
  isTurnStarting: () => boolean;
  /** Start a parent turn with these messages (reports first, then any user message). */
  startTurn: (messages: AgentMessage[]) => Promise<void>;
}

/**
 * Where a settled child's report goes (owner, 2026-11-23):
 * - a parent turn runs: steer it in; the model reads it after the current tool call;
 * - no turn runs: start a parent turn with it, so the work does not look lost;
 * - a turn is starting: keep it and start a turn when that one ends;
 * - Stop drained it from the steering queue: keep it for the next user message
 *   (no new turn right after the user pressed Stop).
 */
export class SubagentReportDelivery {
  private readonly pending: AgentMessage[] = [];

  constructor(private readonly options: SubagentReportDeliveryOptions) {}

  deliver(report: SubagentReport): void {
    if (this.options.isDisposed()) return;
    const message = subagentReportMessage(report);
    const agent = this.options.getAgent();
    if (agent?.state.isStreaming) {
      agent.steer(message);
      return;
    }
    this.pending.push(message);
    if (!this.options.isTurnStarting()) this.flush();
  }

  /** Reports a Stop drained from the queue: kept for the next user message, no new turn. */
  keepDrained(messages: AgentMessage[]): void {
    this.pending.push(...messages);
  }

  /** The reports waiting for a turn; the caller sends them ahead of the user's message. */
  takePending(): AgentMessage[] {
    return this.pending.splice(0);
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** A turn ended: start one for reports that arrived while it was starting. */
  afterTurn(stoppedByUser: boolean): void {
    if (!stoppedByUser && this.pending.length > 0 && !this.options.isDisposed()) this.flush();
  }

  private flush(): void {
    const messages = this.takePending();
    if (messages.length === 0) return;
    void this.options.startTurn(messages).catch((error: unknown) => {
      console.warn("Agentic Chat: could not start a turn for a subagent report.", error);
    });
  }
}
