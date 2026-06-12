/**
 * Live integration tests against the real OpenRouter API.
 *
 * Skipped automatically unless OPENROUTER_API_KEY is set, so the default
 * `npm test` run stays hermetic. Run with `npm run test:live` (see
 * scripts/run-live-tests.sh) which sources the key and sets the model.
 *
 * These hit the network and cost a few tokens per run.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent } from "../../src/agent/agent";
import { defineTool, RunContext } from "../../src/agent/tool";
import { OpenRouterModel, listModels } from "../../src/llm/openrouter";
import { emptyUsage } from "../../src/agent/types";

const apiKey = process.env.OPENROUTER_API_KEY;
const model = process.env.OPENROUTER_TEST_MODEL ?? "deepseek/deepseek-v4-flash";
const LIVE_TIMEOUT = 60_000;

const liveDescribe = apiKey ? describe : describe.skip;

function makeModel(overrides = {}): OpenRouterModel {
  return new OpenRouterModel({
    apiKey: apiKey!,
    model,
    privacy: { denyDataCollection: true, requireZDR: false, allowFallbacks: true },
    temperature: 0,
    maxTokens: 512,
    ...overrides,
  });
}

liveDescribe(`OpenRouter live (${model})`, () => {
  it(
    "streams a plain text completion with usage",
    async () => {
      const deltas: string[] = [];
      const response = await makeModel().request({
        messages: [
          { role: "system", content: "You are terse. Answer with a single word." },
          { role: "user", content: "Reply with exactly the word: pong" },
        ],
        onDelta: (d) => d.text && deltas.push(d.text),
      });

      expect(response.message.role).toBe("assistant");
      expect((response.message.content ?? "").toLowerCase()).toContain("pong");
      expect(deltas.length).toBeGreaterThan(0);
      expect(response.usage.totalTokens).toBeGreaterThan(0);
      expect(response.usage.requests).toBe(1);
    },
    LIVE_TIMEOUT,
  );

  it(
    "requests a tool call when given a tool",
    async () => {
      const response = await makeModel().request({
        messages: [
          {
            role: "system",
            content: "Use the provided tools to answer. Do not guess.",
          },
          { role: "user", content: "What is the weather in Paris? Use the tool." },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Get the current weather for a city.",
              parameters: {
                type: "object",
                properties: { city: { type: "string" } },
                required: ["city"],
              },
            },
          },
        ],
      });

      expect(response.message.tool_calls).toBeDefined();
      const call = response.message.tool_calls![0];
      expect(call.function.name).toBe("get_weather");
      const args = JSON.parse(call.function.arguments) as { city: string };
      expect(args.city.toLowerCase()).toContain("paris");
    },
    LIVE_TIMEOUT,
  );

  it(
    "lists models and reports tool support for the test model",
    async () => {
      const models = await listModels(apiKey!);
      const found = models.find((m) => m.id === model);
      expect(found, `model ${model} not found in catalog`).toBeDefined();
      expect(found!.supportsTools).toBe(true);
    },
    LIVE_TIMEOUT,
  );
});

liveDescribe(`Agent loop live (${model})`, () => {
  interface Deps {
    notes: Map<string, string>;
    reads: string[];
  }

  const readNote = defineTool({
    name: "read_note",
    description: "Read the contents of a note by its path.",
    parameters: z.object({ path: z.string().describe("e.g. 'todo.md'") }),
    execute: ({ path }, { deps }: RunContext<Deps>) => {
      deps.reads.push(path);
      const content = deps.notes.get(path);
      if (content === undefined) return `No note found at ${path}.`;
      return content;
    },
  });

  it(
    "runs a full read-then-answer tool loop end to end",
    async () => {
      const agent = new Agent<Deps>({
        model: makeModel(),
        systemPrompt:
          "You answer questions about the user's notes. Always use read_note to fetch a note before answering. Be concise.",
        tools: [readNote],
        maxSteps: 6,
      });
      const deps: Deps = {
        notes: new Map([["groceries.md", "- milk\n- eggs\n- 7 bananas\n- coffee"]]),
        reads: [],
      };

      const result = await agent.run("How many bananas are on my groceries.md list?", {
        deps,
      });

      expect(deps.reads).toContain("groceries.md");
      expect(result.output).toMatch(/\b(7|seven)\b/i);
      expect(result.usage.requests).toBeGreaterThanOrEqual(2);
      expect(result.steps).toBeGreaterThanOrEqual(2);
    },
    LIVE_TIMEOUT,
  );

  it(
    "recovers from a wrong path via ModelRetry-style feedback",
    async () => {
      const agent = new Agent<Deps>({
        model: makeModel(),
        systemPrompt:
          "Use read_note to read notes. If a note is not found, try a more likely path. Be concise.",
        tools: [readNote],
        maxSteps: 6,
      });
      const deps: Deps = {
        notes: new Map([["projects/roadmap.md", "Q3 goal: ship the agent plugin."]]),
        reads: [],
      };

      const result = await agent.run(
        "What is the Q3 goal? It's in the roadmap note under projects.",
        { deps },
      );

      expect(result.output.toLowerCase()).toContain("agent");
      expect(deps.reads.length).toBeGreaterThanOrEqual(1);
    },
    LIVE_TIMEOUT,
  );

  it("sanity-checks the test harness deps shape", () => {
    const ctx: RunContext<Deps> = {
      deps: { notes: new Map(), reads: [] },
      usage: emptyUsage(),
      retry: 0,
    };
    expect(ctx.deps.reads).toEqual([]);
  });
});
