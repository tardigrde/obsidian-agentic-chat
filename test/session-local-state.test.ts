import { describe, expect, it } from "vitest";
import { AgentSessionLocalState } from "../src/agent/session-local-state";

describe("AgentSessionLocalState", () => {
  it("records subagent usage into the session-local accumulator", () => {
    const state = new AgentSessionLocalState();

    state.recordSubagentUsage({
      input: 2,
      output: 3,
      cacheRead: 4,
      cacheWrite: 5,
      totalTokens: 14,
      cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 },
    });
    state.recordSubagentUsage({
      input: 1,
      output: 1,
      cacheRead: 1,
      cacheWrite: 1,
      totalTokens: 4,
      cost: { input: 0.01, output: 0.01, cacheRead: 0.01, cacheWrite: 0.01, total: 0.04 },
    });

    expect(state.subagentUsage).toMatchObject({
      input: 3,
      output: 4,
      cacheRead: 5,
      cacheWrite: 6,
      totalTokens: 18,
      cost: { input: 0.02, output: 0.03, cacheRead: 0.04, cacheWrite: 0.05, total: 0.14 },
    });
  });

  it("normalizes thrown values into transient error text", () => {
    const state = new AgentSessionLocalState();

    state.setError(new Error("boom"));
    expect(state.error).toBe("boom");

    state.setError("plain failure");
    expect(state.error).toBe("plain failure");

    state.clearError();
    expect(state.error).toBeUndefined();
  });

  it("resets transient error, child usage, and memoized reads", () => {
    const state = new AgentSessionLocalState();
    state.setErrorMessage("old error");
    state.recordSubagentUsage({
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    state.readMemo.mark({ path: "Note.md" });

    state.reset();

    expect(state.error).toBeUndefined();
    expect(state.subagentUsage.totalTokens).toBe(0);
    expect(state.readMemo.has({ path: "Note.md" })).toBe(false);
  });

  it("invalidates memoized reads for externally modified paths", () => {
    const state = new AgentSessionLocalState();
    state.readMemo.mark({ path: "Note.md" });

    state.invalidateRead("Note.md");

    expect(state.readMemo.has({ path: "Note.md" })).toBe(false);
  });
});
