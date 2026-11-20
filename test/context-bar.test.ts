import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contextLevel, contextPercent, lastPromptTokens } from "../src/ui/context-bar";

describe("contextLevel", () => {
  it("is ok below 75%", () => {
    expect(contextLevel(0)).toBe("ok");
    expect(contextLevel(0.5)).toBe("ok");
    expect(contextLevel(0.749)).toBe("ok");
  });
  it("warns from 75% up to 90%", () => {
    expect(contextLevel(0.75)).toBe("warn");
    expect(contextLevel(0.89)).toBe("warn");
  });
  it("is high at 90% and above", () => {
    expect(contextLevel(0.9)).toBe("high");
    expect(contextLevel(1)).toBe("high");
  });
});

describe("contextPercent", () => {
  it("rounds to an integer percentage", () => {
    expect(contextPercent(0.123)).toBe(12);
    expect(contextPercent(0.756)).toBe(76);
  });
  it("clamps to 0–100", () => {
    expect(contextPercent(-1)).toBe(0);
    expect(contextPercent(0)).toBe(0);
    expect(contextPercent(1.5)).toBe(100);
    expect(contextPercent(Number.NaN)).toBe(0);
  });
});

describe("lastPromptTokens", () => {
  it("reads the provider count of the last assistant reply, cache included", () => {
    const messages = [
      { role: "user", content: "hi", timestamp: 1 },
      { role: "assistant", content: [], usage: { input: 100, output: 5, cacheRead: 900, cacheWrite: 0 }, timestamp: 2 },
      { role: "toolResult", content: [], timestamp: 3 },
    ] as unknown as AgentMessage[];
    expect(lastPromptTokens(messages)).toBe(1_000);
  });

  it("is undefined before the first reply or when the reply has no usage", () => {
    expect(lastPromptTokens([])).toBeUndefined();
    expect(lastPromptTokens([{ role: "assistant", content: [], timestamp: 1 }] as unknown as AgentMessage[])).toBeUndefined();
  });
});
