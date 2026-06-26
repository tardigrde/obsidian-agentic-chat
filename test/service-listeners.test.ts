import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { AgentServiceListeners } from "../src/agent/service-listeners";

describe("AgentServiceListeners", () => {
  it("fans out agent events until the listener unsubscribes", () => {
    const listeners = new AgentServiceListeners();
    const seen: AgentEvent[] = [];
    const unsubscribe = listeners.onEvent((event) => {
      seen.push(event);
    });

    listeners.emitEvent({ type: "agent_start" });
    unsubscribe();
    listeners.emitEvent({ type: "agent_end", messages: [] });

    expect(seen.map((event) => event.type)).toEqual(["agent_start"]);
  });

  it("fans out change notifications until the listener unsubscribes", () => {
    const listeners = new AgentServiceListeners();
    let calls = 0;
    const unsubscribe = listeners.onChange(() => {
      calls += 1;
    });

    listeners.notifyChange();
    unsubscribe();
    listeners.notifyChange();

    expect(calls).toBe(1);
  });

  it("clears all listeners", () => {
    const listeners = new AgentServiceListeners();
    let events = 0;
    let changes = 0;
    listeners.onEvent(() => {
      events += 1;
    });
    listeners.onChange(() => {
      changes += 1;
    });

    listeners.clear();
    listeners.emitEvent({ type: "agent_start" });
    listeners.notifyChange();

    expect(events).toBe(0);
    expect(changes).toBe(0);
  });
});
