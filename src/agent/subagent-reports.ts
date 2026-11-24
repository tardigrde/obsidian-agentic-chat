import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { UserMessage } from "@earendil-works/pi-ai";
import type { SubagentChildStatus, SubagentReport } from "../tools/subagent-tool";
import { unwrapToolOutput, wrapToolOutput } from "../tools/tool-output-wrapper";

/**
 * A background child's report reaches the parent as a user-role message (U5
 * #1). It is a plain user message, so the session file format does not change;
 * the opening tag marks it, so the UI renders it as an event, not as the
 * user's words, and the steering drain never puts it back in the composer.
 */
const OPENING = /^<subagent_report((?: [a-z]+="[^"]*")+)>\n/u;
const ATTRIBUTE = / ([a-z]+)="([^"]*)"/gu;
const CLOSING = "\n</subagent_report>";
const SOURCES_PREFIX = "\n\nVault files read: ";

export interface ParsedSubagentReport {
  childId: string;
  agent: string;
  status: SubagentChildStatus["status"];
  toolCallId: string;
  /** The model-facing text, still wrapped as untrusted output. */
  body: string;
  /** For the row after a reload: run time, cost, and the full-report artifact. */
  durationMs?: number;
  costUsd?: number;
  /** Vault files the child read (U5 #14). */
  sources?: string[];
  /** The child's stored timeline (U5 #12). */
  timelineArtifactId?: string;
  /** The child's token usage; the session total counts it from here, so it survives a reload. */
  usage?: { input: number; output: number; totalTokens: number; costUsd: number };
  artifactId?: string;
}

const attr = (value: string): string => value.replace(/["<>\n\r]/gu, " ").trim();

export function formatSubagentReport(report: SubagentReport): string {
  const child = report.details.children[0];
  const extra = [
    child?.durationMs !== undefined ? ` ms="${Math.round(child.durationMs)}"` : "",
    child?.usage
      ? ` in="${child.usage.input}" out="${child.usage.output}" tokens="${child.usage.totalTokens}" cost="${child.usage.costUsd}"`
      : "",
    child?.artifactId ? ` artifact="${attr(child.artifactId)}"` : "",
    child?.timelineArtifactId ? ` timeline="artifact:${attr(child.timelineArtifactId)}"` : "",
    // A number cannot carry text: the parser takes the trailer only when its count matches.
    child?.sources?.length ? ` nsrc="${child.sources.length}"` : "",
  ].join("");
  const header = `<subagent_report id="${attr(report.childId)}" agent="${attr(report.agent)}" status="${attr(child?.status ?? "done")}" call="${attr(report.toolCallId)}"${extra}>`;
  // The body is the child's output: data from notes and the web, never instructions.
  // Vault file names are data too (a note can be named like an instruction): they go
  // inside the wrapper, never into the header attributes (review of #431).
  const sources = child?.sources?.length ? `${SOURCES_PREFIX}${JSON.stringify(child.sources)}` : "";
  return `${header}\n${wrapToolOutput(`${report.text}${sources}`, "subagent")}${CLOSING}`;
}

/**
 * Split the vault files the child read off the end of the unwrapped payload; the body stays wrapped.
 * `expected` is the header's `nsrc`: with none, a trailer in the child's own text is plain text.
 */
function splitSources(wrappedBody: string, expected: number): { body: string; sources?: string[] } {
  if (expected <= 0) return { body: wrappedBody };
  const inner = unwrapToolOutput(wrappedBody);
  const at = inner.lastIndexOf(SOURCES_PREFIX);
  if (at === -1 || inner.includes("\n", at + SOURCES_PREFIX.length)) return { body: wrappedBody };
  try {
    const parsed: unknown = JSON.parse(inner.slice(at + SOURCES_PREFIX.length));
    if (!Array.isArray(parsed) || parsed.length !== expected || !parsed.every((path) => typeof path === "string")) {
      return { body: wrappedBody };
    }
    return { body: wrapToolOutput(inner.slice(0, at), "subagent"), sources: parsed.filter(Boolean) };
  } catch {
    return { body: wrappedBody };
  }
}

export function parseSubagentReport(text: string): ParsedSubagentReport | null {
  const match = OPENING.exec(text);
  if (!match || !text.endsWith(CLOSING)) return null;
  const attrs = new Map([...match[1].matchAll(ATTRIBUTE)].map((entry) => [entry[1], entry[2]]));
  const id = attrs.get("id");
  const agent = attrs.get("agent");
  const status = attrs.get("status");
  const call = attrs.get("call");
  if (id === undefined || agent === undefined || status === undefined || call === undefined) return null;
  const ms = Number(attrs.get("ms"));
  const cost = Number(attrs.get("cost"));
  const count = (name: string): number => {
    const value = Number(attrs.get(name));
    return Number.isFinite(value) ? value : 0;
  };
  const { body, sources } = splitSources(text.slice(match[0].length, text.length - CLOSING.length), count("nsrc"));
  return {
    childId: id,
    agent,
    status: status as SubagentChildStatus["status"],
    toolCallId: call,
    body,
    ...(attrs.has("ms") && Number.isFinite(ms) ? { durationMs: ms } : {}),
    ...(attrs.has("cost") && Number.isFinite(cost) ? { costUsd: cost } : {}),
    ...(attrs.has("tokens")
      ? { usage: { input: count("in"), output: count("out"), totalTokens: count("tokens"), costUsd: Number.isFinite(cost) ? cost : 0 } }
      : {}),
    ...(attrs.get("artifact") ? { artifactId: attrs.get("artifact") } : {}),
    ...(attrs.get("timeline")?.startsWith("artifact:") ? { timelineArtifactId: (attrs.get("timeline") as string).slice("artifact:".length) } : {}),
    ...(sources?.length ? { sources } : {}),
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
  // A user message, not a tool result: built like `createUserMessage` in the agent service.
  const content: UserMessage["content"] = [{ type: "text", text: formatSubagentReport(report) }];
  return { role: "user", content, timestamp: Date.now() };
}

export interface SubagentReportDeliveryOptions {
  getAgent: () => Agent | undefined;
  isDisposed: () => boolean;
  /** True while a parent turn is being set up but `isStreaming` is not yet set. */
  isTurnStarting: () => boolean;
  /**
   * Start a parent turn that takes the waiting reports itself (`takePending`
   * inside its run). A turn that never runs (a blocked preflight, a turn
   * already starting) takes nothing, so no report is lost (review of #431).
   */
  startTurn: () => Promise<void>;
}

interface PendingReport {
  message: AgentMessage;
  /** False for a stop report: the user stopped that work, so it never starts a turn by itself. */
  startsTurn: boolean;
}

/**
 * Where a settled child's report goes (owner, 2026-11-23):
 * - a parent turn runs: steer it in; the model reads it after the current tool call;
 * - no turn runs: start a parent turn with it, so the work does not look lost;
 * - a turn is starting: keep it; start a turn when that one has run;
 * - after a user Stop, and for a stopped child's report: keep it for the next
 *   user message; nothing starts a turn by itself.
 * A session change drops what waits: a report belongs to the conversation
 * that started its child.
 */
export class SubagentReportDelivery {
  private readonly pending: PendingReport[] = [];
  /** Set by a user Stop until the user sends again. */
  private paused = false;

  constructor(private readonly options: SubagentReportDeliveryOptions) {}

  deliver(report: SubagentReport): void {
    if (this.options.isDisposed()) return;
    const message = subagentReportMessage(report);
    const agent = this.options.getAgent();
    // After a Stop the aborted turn can still read as streaming: keep the report for the next user message.
    if (agent?.state.isStreaming && !this.paused) {
      agent.steer(message);
      return;
    }
    const startsTurn = report.details.children[0]?.status !== "aborted";
    this.pending.push({ message, startsTurn });
    if (startsTurn) this.maybeStartTurn();
  }

  /** Reports drained from the steering queue (a Stop, or a steer after the last poll). */
  keepDrained(messages: AgentMessage[], options: { startsTurn: boolean }): void {
    for (const message of messages) {
      // A stopped child's report never starts a turn, even when it was drained from a turn that ended (review of #431).
      const stopped = parseSubagentReport(messageText(message))?.status === "aborted";
      this.pending.push({ message, startsTurn: options.startsTurn && !stopped });
    }
  }

  /** The user pressed Stop: no report starts a turn by itself until the user sends again. */
  pauseAfterStop(): void {
    this.paused = true;
  }

  /** The user sent or steered: automatic delivery resumes. */
  resume(): void {
    this.paused = false;
  }

  /** The reports waiting for a turn, taken by the turn that sends them (user's or automatic). */
  takePending(): AgentMessage[] {
    return this.pending.splice(0).map((entry) => entry.message);
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** The session was cleared or replaced: its waiting reports go with it. */
  reset(): void {
    this.pending.length = 0;
    this.paused = false;
  }

  /** A turn ended. Only a turn that ran may start the next one (no retry loop on a blocked start). */
  afterTurn(ran: boolean): void {
    if (ran) this.maybeStartTurn();
  }

  private maybeStartTurn(): void {
    if (this.paused || this.options.isDisposed() || this.options.isTurnStarting()) return;
    if (!this.pending.some((entry) => entry.startsTurn)) return;
    void this.options.startTurn().catch((error: unknown) => {
      // The reports stay in `pending` unless the turn took them: the next user message sends them.
      console.warn("Agentic Chat: could not start a turn for a subagent report.", error);
    });
  }
}

/** The row status a report settles (live or replayed): what `SubagentChildView` draws. */
export function reportChildDetails(report: ParsedSubagentReport, summary: string): { kind: "subagent"; children: SubagentChildStatus[] } {
  return {
    kind: "subagent",
    children: [
      {
        agent: report.agent,
        task: "",
        status: report.status,
        childId: report.childId,
        summary,
        ...(report.durationMs !== undefined ? { durationMs: report.durationMs } : {}),
        ...(report.usage
          ? { usage: report.usage }
          : report.costUsd !== undefined
            ? { usage: { input: 0, output: 0, totalTokens: 0, costUsd: report.costUsd } }
            : {}),
        ...(report.artifactId ? { artifactId: report.artifactId } : {}),
        ...(report.timelineArtifactId ? { timelineArtifactId: report.timelineArtifactId } : {}),
      },
    ],
  };
}
