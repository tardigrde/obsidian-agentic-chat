import { describe, expect, it } from "vitest";
import {
  BUILTIN_CHARTERS,
  extractJsonObject,
  explorerSystemPrompt,
  explorerUserPrompt,
  formatObservation,
  parseExplorerDecision,
  parseKeyChord,
  resolveReplayRef,
  summarizeDecision,
  sumSessionUsage,
  type Observation,
  type UiElement,
} from "../scripts/chaos/explorer-core";
import { parseChatResponse } from "../scripts/chaos/explorer-llm";
import {
  CHAOS_MODEL,
  ChaosGuardError,
  DEFAULT_DRY_RUN_CAPS,
  DEFAULT_EXPLORE_CAPS,
  assertChaosModel,
  selectMode,
} from "../scripts/chaos/monkey-core";
import { planChaosBudget, genericSequence } from "../scripts/chaos/monkey-actions";

const elements: UiElement[] = [
  { ref: "w0e1", window: 0, region: "chat", role: "button", label: "Send" },
  { ref: "w0e2", window: 0, region: "chat", role: "textarea", label: "Ask about your vault", value: "hi" },
  { ref: "w1e1", window: 1, region: "settings", role: "toggle", label: "Enable MCP", checked: false },
];

function observation(): Observation {
  return {
    step: 3,
    windows: [
      { index: 0, title: "vault - Obsidian", modalTitles: [], notices: ["Saved"], elements: elements.slice(0, 2), hidden: 4 },
      { index: 1, title: "Settings", modalTitles: [], notices: [], elements: elements.slice(2), hidden: 0 },
    ],
    chat: {
      open: true,
      running: false,
      composer: "hi",
      errorPanels: 0,
      approvalOpen: false,
      overflowX: false,
      lastMessages: [{ role: "assistant", text: "Hello" }],
    },
    vaultFiles: ["Welcome.md"],
    errors: ["w0 uncaught: boom"],
    signals: ["protected settings were changed and restored: openaiCompatibleModel"],
    budget: { stepsLeft: 10, secondsLeft: 100, tokensLeft: 5000 },
  };
}

describe("chaos model lock", () => {
  it("accepts DeepSeek V4.1 Flash ids and refuses other models", () => {
    expect(assertChaosModel(CHAOS_MODEL)).toBe(CHAOS_MODEL);
    expect(assertChaosModel("deepseek/deepseek-v4.1-flash-1017")).toBe("deepseek/deepseek-v4.1-flash-1017");
    for (const model of ["moonshotai/kimi-k2.6", "openrouter/auto", "deepseek/deepseek-v4-pro", "deepseek-v4.1-flash-max"]) {
      expect(() => assertChaosModel(model)).toThrow(ChaosGuardError);
    }
    expect(assertChaosModel("moonshotai/kimi-k2.6", true)).toBe("moonshotai/kimi-k2.6");
  });
});

describe("chaos explore mode and caps", () => {
  it("selects explore without a target and refuses a target", () => {
    expect(selectMode("explore", undefined)).toEqual({ mode: "explore" });
    expect(() => selectMode("explore", "settings")).toThrow(ChaosGuardError);
  });

  it("defaults explore to an open-ended budget", () => {
    expect(DEFAULT_EXPLORE_CAPS).toEqual({ maxSteps: 150, maxSeconds: 1800, maxCalls: 600, maxTokens: 2_000_000 });
  });

  it("does not let the dry-run call cap starve a generic run", () => {
    // Witness for the 2026-11-11 dry run that ran 3 of 10 steps: free scripted
    // calls must not skip planned steps.
    const caps = { ...DEFAULT_DRY_RUN_CAPS, maxSteps: 10 };
    for (const seed of [1, 7, 42, 1234]) {
      const sequence = genericSequence(caps, seed);
      const plan = planChaosBudget(sequence, caps.maxCalls);
      expect(plan.steps.filter((step) => step.status === "skipped")).toEqual([]);
    }
  });
});

describe("explorer decision parsing", () => {
  it("parses a fenced JSON reply with the shared fields", () => {
    const parsed = parseExplorerDecision(
      'Sure.\n```json\n{"thought":"try send","previous":"surprising","surprise":"no reply","expect":"an answer","action":"click","ref":"w0e1"}\n```',
    );
    expect(parsed).toEqual({
      ok: true,
      decision: {
        action: "click",
        ref: "w0e1",
        thought: "try send",
        expect: "an answer",
        previous: "surprising",
        surprise: "no reply",
        memory: undefined,
      },
    });
  });

  it("clamps waits, defaults send to wait, and normalizes report severity", () => {
    const wait = parseExplorerDecision('{"action":"wait","seconds":500}');
    expect(wait.ok && wait.decision.action === "wait" && wait.decision.seconds).toBe(30);
    const send = parseExplorerDecision('{"action":"send","text":"hi"}');
    expect(send.ok && send.decision.action === "send" && send.decision.wait).toBe(true);
    const report = parseExplorerDecision('{"action":"report","severity":"s9","title":"t","detail":"d"}');
    expect(report.ok && report.decision.action === "report" && report.decision.severity).toBe("S3");
  });

  it("rejects bad refs, unknown actions, and non-JSON replies with a reason", () => {
    expect(parseExplorerDecision('{"action":"click","ref":"button 3"}')).toMatchObject({ ok: false, error: expect.stringContaining("w0e12") });
    expect(parseExplorerDecision('{"action":"fly"}')).toMatchObject({ ok: false, error: expect.stringContaining("unknown action") });
    expect(parseExplorerDecision("I will click send")).toEqual({ ok: false, error: "reply had no JSON object" });
  });

  it("extracts the first balanced object even with braces inside strings", () => {
    expect(extractJsonObject('x {"a":"}{","b":{"c":1}} y')).toBe('{"a":"}{","b":{"c":1}}');
  });
});

describe("explorer view and prompt", () => {
  it("renders windows, regions, flags, errors, and signals", () => {
    const text = formatObservation(observation());
    expect(text).toContain('w0e2 textarea "Ask about your vault" value="hi"');
    expect(text).toContain('w1e1 toggle "Enable MCP" off');
    expect(text).toContain("WINDOW 1 \"Settings\"");
    expect(text).toContain("! w0 uncaught: boom");
    expect(text).toContain("(+4 more elements not shown");
    expect(text).toContain("protected settings were changed and restored");
  });

  it("puts charter, memory, history, and the rejection reason in the user prompt", () => {
    const prompt = explorerUserPrompt({
      charter: BUILTIN_CHARTERS.broad,
      memory: "settings done",
      history: [{ step: 2, summary: "click Send", outcome: "clicked" }],
      observation: observation(),
      lastError: "unknown action",
    });
    expect(prompt).toContain("CHARTER");
    expect(prompt).toContain("settings done");
    expect(prompt).toContain("#2 click Send -> clicked");
    expect(prompt).toContain("YOUR LAST REPLY WAS REJECTED: unknown action");
  });

  it("lists scenarios and forbids protected settings in the system prompt", () => {
    const system = explorerSystemPrompt(["queue", "steer"], ["agentic-chat:open-chat"]);
    expect(system).toContain("Names: queue, steer");
    expect(system).toContain("agentic-chat:open-chat");
    expect(system).toMatch(/Do not change the provider, model, base URL, or API key/);
  });

  it("summarizes a decision with the target label", () => {
    expect(summarizeDecision({ action: "click", ref: "w0e1" }, elements)).toBe('click button "Send" (chat, w0)');
    expect(summarizeDecision({ action: "send", text: "hello", wait: false })).toBe('send "hello" (no wait)');
  });
});

describe("explorer replay and keys", () => {
  it("finds a recorded target again by window, role, and label", () => {
    const fresh: UiElement[] = [
      { ref: "w0e7", window: 0, region: "chat", role: "button", label: "Send" },
      { ref: "w1e3", window: 1, region: "settings", role: "toggle", label: "Enable MCP" },
    ];
    expect(resolveReplayRef({ window: 0, region: "chat", role: "button", label: "Send" }, fresh)).toBe("w0e7");
    expect(resolveReplayRef({ window: 1, region: "other", role: "div", label: "Enable MCP" }, fresh)).toBe("w1e3");
    expect(resolveReplayRef({ window: 0, region: "chat", role: "button", label: "Gone" }, fresh)).toBeUndefined();
  });

  it("maps key chords to WebDriver names", () => {
    expect(parseKeyChord("Mod+Shift+P", "linux")).toEqual(["Control", "Shift", "p"]);
    expect(parseKeyChord("Mod+P", "darwin")).toEqual(["Meta", "p"]);
    expect(parseKeyChord("Esc")).toEqual(["Escape"]);
    expect(() => parseKeyChord("Hyper+X")).toThrow(/unknown key/);
  });
});

describe("explorer usage accounting", () => {
  it("sums real tokens and cost from assistant messages and lists the models", () => {
    const line = (model: string, tokens: number, cost: number): string =>
      JSON.stringify({ type: "message", message: { role: "assistant", model, usage: { totalTokens: tokens, cost: { total: cost } } } });
    const usage = sumSessionUsage([
      [line("deepseek/deepseek-v4.1-flash", 100, 0.001), JSON.stringify({ type: "message", message: { role: "user" } }), "not json"].join("\n"),
      line("deepseek/deepseek-v4.1-flash", 50, 0.0005),
    ]);
    expect(usage).toEqual({ tokens: 150, cost: 0.0015, assistantMessages: 2, models: ["deepseek/deepseek-v4.1-flash"] });
  });

  it("reads OpenRouter usage and cost from a chat response", () => {
    const reply = parseChatResponse(
      { model: "deepseek/deepseek-v4.1-flash", choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.0002 } },
      "fallback",
    );
    expect(reply).toEqual({
      text: "{}",
      model: "deepseek/deepseek-v4.1-flash",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cost: 0.0002 },
    });
    expect(() => parseChatResponse({ error: { message: "no credits" } }, "m")).toThrow(/no credits/);
  });
});

describe("explorer loop guard", () => {
  it("warns at three recent failures of one action and skips at five, even with steps in between", async () => {
    const { loopVerdict } = await import("../scripts/chaos/explorer-core");
    const fail = (step: number) => ({ step, summary: 'type "x" into input', outcome: "failed: gone" });
    const other = (step: number) => ({ step, summary: "click Rename", outcome: "clicked" });
    expect(loopVerdict('type "x" into input', [fail(1), other(2), fail(3)])).toEqual({ action: "run" });
    expect(loopVerdict('type "x" into input', [fail(1), other(2), fail(3), other(4), fail(5)]).action).toBe("warn");
    const five = [fail(1), other(2), fail(3), other(4), fail(5), other(6), fail(7), other(8), fail(9)];
    expect(loopVerdict('type "x" into input', five).action).toBe("skip");
    expect(loopVerdict("click Rename", five)).toEqual({ action: "run" });
  });
});
