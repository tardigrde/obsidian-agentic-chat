import type { AgentEvent, Usage } from "../agent/types";

export interface ToolStep {
  id: string;
  name: string;
  arguments: string;
  status: "running" | "done" | "error";
  result?: string;
}

export interface UserItem {
  kind: "user";
  text: string;
  attachments: string[];
}

export interface AssistantItem {
  kind: "assistant";
  text: string;
  reasoning: string;
  steps: ToolStep[];
  status: "streaming" | "done" | "error" | "stopped";
  error?: string;
  usage?: Usage;
}

export type ChatItem = UserItem | AssistantItem;

/**
 * UI-agnostic conversation state. Agent events are folded into a list of
 * chat items so the view layer only has to render, never interpret.
 */
export class ConversationStore {
  readonly items: ChatItem[] = [];

  addUser(text: string, attachments: string[] = []): UserItem {
    const item: UserItem = { kind: "user", text, attachments };
    this.items.push(item);
    return item;
  }

  beginAssistant(): AssistantItem {
    const item: AssistantItem = {
      kind: "assistant",
      text: "",
      reasoning: "",
      steps: [],
      status: "streaming",
    };
    this.items.push(item);
    return item;
  }

  /** The assistant item currently being streamed into, if any. */
  get lastAssistant(): AssistantItem | undefined {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      if (item.kind === "assistant") return item;
    }
    return undefined;
  }

  applyAgentEvent(event: AgentEvent): void {
    const item = this.lastAssistant;
    if (!item) return;
    switch (event.type) {
      case "text_delta":
        item.text += event.delta;
        break;
      case "reasoning_delta":
        item.reasoning += event.delta;
        break;
      case "tool_call_start":
        item.steps.push({
          id: event.id,
          name: event.name,
          arguments: event.arguments,
          status: "running",
        });
        break;
      case "tool_call_end": {
        const step = item.steps.find((s) => s.id === event.id && s.status === "running");
        if (step) {
          step.status = event.isError ? "error" : "done";
          step.result = event.result;
        }
        break;
      }
      case "run_end":
        item.status = "done";
        item.text = event.output;
        item.usage = event.usage;
        break;
      case "run_error":
        if (item.status === "streaming") {
          item.status = "error";
          item.error = event.message;
        }
        break;
      case "run_start":
      case "step_start":
        break;
    }
  }

  /** Mark the in-flight assistant turn as user-cancelled (overrides errors). */
  markStopped(): void {
    const item = this.lastAssistant;
    if (!item || item.status === "done") return;
    item.status = "stopped";
    item.error = undefined;
    for (const step of item.steps) {
      if (step.status === "running") step.status = "error";
    }
  }

  reset(): void {
    this.items.length = 0;
  }
}
