import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { activeModelId, type AgenticChatSettings } from "../settings-schema";
import type { WebFetcher } from "../tools/web-fetch";
import type { ApprovalAuditInput } from "../agent/action-audit-log";
import { errorMessage } from "../utils/errors";
import { observabilityTraceEndpoint, type OtlpAttributeValue } from "./otlp";
import { SpanExporter, type ObservabilityExportHealth } from "./export";
import {
  addAssistantModelAttributes,
  addAssistantUsageAttributes,
  addContentAttribute,
  createMutableSpan,
  endSpan,
  hasRequiredAuth,
  messageText,
  normalizeHex,
  randomHex,
  safePreview,
  shouldSample,
  stableSessionId,
  startSpan,
  statusForAssistant,
  type ActiveTrace,
  type MutableSpan,
  type ObservabilitySessionContext,
} from "./spans";

export type { ObservabilityExportHealth } from "./export";
export type { ObservabilitySessionContext } from "./spans";

export interface AgentObservabilityRuntimeOptions {
  getSettings: () => AgenticChatSettings;
  fetcher: WebFetcher;
  getSessionContext: () => ObservabilitySessionContext;
  now?: () => number;
  random?: () => number;
  idFactory?: () => string;
}

export class AgentObservabilityRuntime {
  private active: ActiveTrace | null = null;
  private readonly exporter: SpanExporter;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly idFactory: () => string;

  constructor(private readonly options: AgentObservabilityRuntimeOptions) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.idFactory = options.idFactory ?? (() => randomHex(16));
    this.exporter = new SpanExporter({ fetcher: options.fetcher, now: this.now });
  }

  handleAgentEvent(event: AgentEvent): void {
    try {
      this.handleEvent(event);
    } catch (error) {
      console.warn(`Agentic Chat observability: ${errorMessage(error)}`);
    }
  }

  recordApproval(input: ApprovalAuditInput): void {
    try {
      const trace = this.active;
      if (!trace?.sampled) return;
      const parent = trace.toolSpans.get(input.toolCallId) ?? trace.root;
      const span = this.startSpan(trace, "approval.decision", parent.spanId, {
        "langfuse.observation.type": "event",
        "agentic.approval.decision": input.decision,
        "agentic.tool.name": input.toolName,
        "agentic.tool.call_id": input.toolCallId,
      });
      if (input.reason) span.attributes["agentic.approval.reason"] = safePreview(input.reason);
      this.endSpan(span, { code: input.decision === "denied" ? "error" : "ok", message: input.reason });
    } catch (error) {
      console.warn(`Agentic Chat observability approval event failed: ${errorMessage(error)}`);
    }
  }

  async flush(): Promise<void> {
    const trace = this.active;
    this.active = null;
    if (!trace?.sampled) return;
    await this.exporter.export(trace);
  }

  getHealth(): ObservabilityExportHealth {
    return this.exporter.getHealth();
  }

  private handleEvent(event: AgentEvent): void {
    if (event.type === "agent_start") {
      this.startTrace();
      return;
    }
    const trace = this.active;
    if (!trace?.sampled) return;

    if (event.type === "message_end") {
      this.captureMessageEnd(trace, event.message);
      return;
    }
    if (event.type === "message_start" && event.message.role === "assistant") {
      this.startGeneration(trace, event.message);
      return;
    }
    if (event.type === "tool_execution_start") {
      this.startTool(trace, event.toolCallId, event.toolName);
      return;
    }
    if (event.type === "tool_execution_end") {
      this.endTool(trace, event.toolCallId, event.toolName, event.isError);
      return;
    }
    if (event.type === "agent_end") {
      this.endSpan(trace.root, { code: "ok" });
      void this.flush().catch((error) => {
        console.warn(`Agentic Chat observability export failed: ${errorMessage(error)}`);
      });
    }
  }

  private startTrace(): void {
    const settings = { ...this.options.getSettings().observability };
    if (!settings.enabled || !observabilityTraceEndpoint(settings) || !hasRequiredAuth(settings)) {
      this.active = null;
      return;
    }
    const sampled = shouldSample(settings.sampleRate, this.random);
    if (!sampled) this.exporter.recordDroppedTrace();
    const context = this.options.getSettings();
    const session = this.options.getSessionContext();
    const traceId = this.traceId();
    const root = createMutableSpan(
      traceId,
      "agentic.turn",
      undefined,
      {
        "langfuse.trace.name": "Agentic Chat turn",
        "langfuse.session.id": stableSessionId(session),
        "langfuse.trace.tags": ["agentic-chat", context.provider],
        "agentic.provider": context.provider,
        "agentic.model": activeModelId(context),
        "agentic.mode": context.mode,
        "agentic.output_style": context.outputStyle,
        "agentic.thinking_level": context.thinkingLevel,
        "agentic.observability.payload_mode": settings.payloadMode,
      },
      this.now(),
      this.spanId(),
    );
    this.active = {
      settings,
      traceId,
      root,
      spans: [root],
      toolSpans: new Map(),
      generationSpan: null,
      sampled,
    };
  }

  private startGeneration(trace: ActiveTrace, message: AgentMessage): void {
    if (trace.generationSpan && !trace.generationSpan.endMs) this.endSpan(trace.generationSpan, { code: "unset" });
    const span = this.startSpan(trace, "llm.generation", trace.root.spanId, {
      "langfuse.observation.type": "generation",
      "agentic.message.role": "assistant",
    });
    addAssistantModelAttributes(span, message, trace.settings.payloadMode);
    trace.generationSpan = span;
  }

  private captureMessageEnd(trace: ActiveTrace, message: AgentMessage): void {
    if (message.role === "user") {
      addContentAttribute(trace.root, "langfuse.trace.input", messageText(message), trace.settings.payloadMode);
      trace.root.attributes["agentic.input_chars"] = messageText(message).length;
      return;
    }
    if (message.role !== "assistant") return;
    const generation = trace.generationSpan ?? this.startSpan(trace, "llm.generation", trace.root.spanId, {
      "langfuse.observation.type": "generation",
      "agentic.message.role": "assistant",
    });
    addAssistantModelAttributes(generation, message, trace.settings.payloadMode);
    addAssistantUsageAttributes(generation, message);
    const output = messageText(message);
    addContentAttribute(generation, "langfuse.observation.output", output, trace.settings.payloadMode);
    addContentAttribute(trace.root, "langfuse.trace.output", output, trace.settings.payloadMode);
    generation.attributes["agentic.output_chars"] = output.length;
    this.endSpan(generation, statusForAssistant(message));
    trace.generationSpan = null;
  }

  private startTool(trace: ActiveTrace, toolCallId: string, toolName: string): void {
    const span = this.startSpan(trace, "tool.call", trace.root.spanId, {
      "langfuse.observation.type": "span",
      "agentic.tool.name": toolName,
      "agentic.tool.call_id": toolCallId,
    });
    trace.toolSpans.set(toolCallId, span);
  }

  private endTool(trace: ActiveTrace, toolCallId: string, toolName: string, isError: boolean): void {
    const span = trace.toolSpans.get(toolCallId) ?? this.startSpan(trace, "tool.call", trace.root.spanId, {
      "langfuse.observation.type": "span",
      "agentic.tool.name": toolName,
      "agentic.tool.call_id": toolCallId,
    });
    span.attributes["agentic.tool.error"] = isError;
    this.endSpan(span, { code: isError ? "error" : "ok" });
    trace.toolSpans.delete(toolCallId);
  }

  private startSpan(
    trace: ActiveTrace,
    name: string,
    parentSpanId: string | undefined,
    attributes: Record<string, OtlpAttributeValue>,
  ): MutableSpan {
    return startSpan(trace, name, parentSpanId, attributes, this.now(), this.spanId());
  }

  private endSpan(span: MutableSpan, status: Parameters<typeof endSpan>[1]): void {
    endSpan(span, status, this.now());
  }

  private traceId(): string {
    return normalizeHex(this.idFactory(), 32);
  }

  private spanId(): string {
    return normalizeHex(this.idFactory(), 16);
  }
}
