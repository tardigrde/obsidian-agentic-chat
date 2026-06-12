import type {
  Model,
  ModelRequestOptions,
  ModelResponse,
  StreamDelta,
  Usage,
} from "../../src/agent/types";

type Scripted = ModelResponse & { deltas?: StreamDelta[] };

/** Deterministic Model that replays scripted responses and records requests. */
export class FakeModel implements Model {
  readonly id = "fake-model";
  readonly requests: ModelRequestOptions[] = [];

  constructor(private readonly responses: Scripted[]) {}

  async request(options: ModelRequestOptions): Promise<ModelResponse> {
    this.requests.push(options);
    const next = this.responses.shift();
    if (!next) throw new Error("FakeModel: no scripted response left");
    for (const delta of next.deltas ?? []) {
      options.onDelta?.(delta);
    }
    const { deltas: _deltas, ...response } = next;
    return response;
  }
}

export function usageOf(prompt: number, completion: number): Usage {
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: prompt + completion,
    requests: 1,
  };
}

export function textResponse(content: string, usage = usageOf(0, 0)): Scripted {
  return {
    message: { role: "assistant", content },
    usage,
    finishReason: "stop",
  };
}

export function toolCallResponse(
  name: string,
  args: unknown,
  id = "call_1",
  usage = usageOf(0, 0),
): Scripted {
  return {
    message: {
      role: "assistant",
      content: null,
      tool_calls: [
        { id, type: "function", function: { name, arguments: JSON.stringify(args) } },
      ],
    },
    usage,
    finishReason: "tool_calls",
  };
}
