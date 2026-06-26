import { describe, expect, it, vi } from "vitest";
import type { Agent } from "@earendil-works/pi-agent-core";
import { ParentAgentLifecycle } from "../src/agent/parent-agent-lifecycle";

function fakeAgent(): { agent: Agent; abort: ReturnType<typeof vi.fn> } {
  const abort = vi.fn();
  return {
    agent: { abort } as unknown as Agent,
    abort,
  };
}

describe("ParentAgentLifecycle", () => {
  it("replaces the current agent by unsubscribing the old handle without aborting it", () => {
    const lifecycle = new ParentAgentLifecycle();
    const first = fakeAgent();
    const second = fakeAgent();
    const unsubscribeFirst = vi.fn();
    const unsubscribeSecond = vi.fn();

    expect(lifecycle.replace(() => ({ agent: first.agent, unsubscribe: unsubscribeFirst }))).toBe(first.agent);
    expect(lifecycle.current).toBe(first.agent);

    expect(lifecycle.replace(() => ({ agent: second.agent, unsubscribe: unsubscribeSecond }))).toBe(second.agent);
    expect(unsubscribeFirst).toHaveBeenCalledTimes(1);
    expect(first.abort).not.toHaveBeenCalled();
    expect(unsubscribeSecond).not.toHaveBeenCalled();
    expect(lifecycle.current).toBe(second.agent);
  });

  it("detaches by unsubscribing, aborting, and clearing the current agent", () => {
    const lifecycle = new ParentAgentLifecycle();
    const agent = fakeAgent();
    const unsubscribe = vi.fn();

    lifecycle.replace(() => ({ agent: agent.agent, unsubscribe }));
    lifecycle.detach();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(agent.abort).toHaveBeenCalledTimes(1);
    expect(lifecycle.current).toBeNull();
  });

  it("disposes once and prevents later replacement", () => {
    const lifecycle = new ParentAgentLifecycle();
    const agent = fakeAgent();
    const unsubscribe = vi.fn();
    const createReplacement = vi.fn();

    lifecycle.replace(() => ({ agent: agent.agent, unsubscribe }));

    expect(lifecycle.dispose()).toBe(true);
    expect(lifecycle.dispose()).toBe(false);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(agent.abort).toHaveBeenCalledTimes(1);
    expect(lifecycle.current).toBeNull();
    expect(lifecycle.isDisposed).toBe(true);

    expect(lifecycle.replace(createReplacement)).toBeNull();
    expect(createReplacement).not.toHaveBeenCalled();
  });
});
