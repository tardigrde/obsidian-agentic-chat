import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentChildStatus } from "../../src/tools/subagent-tool";
import { SubagentBlock } from "../../src/ui/subagent-tree";

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const child = (task: string, status: SubagentChildStatus["status"] = "done"): SubagentChildStatus =>
  ({ agent: "explorer", task, status }) as SubagentChildStatus;

describe("SubagentBlock rows", () => {
  it("a shorter report drops the rows it no longer has, and keeps other dispatches", () => {
    const parent = document.createElement("div");
    const anchor = parent.createDiv();
    const block = new SubagentBlock(anchor, { live: false });
    block.update("call-a", [child("one"), child("two"), child("three")]);
    block.update("call-b", [child("other")]);
    expect(parent.querySelectorAll('[data-ac="subagent-row"]')).toHaveLength(4);

    block.update("call-a", [child("one")]);
    const tasks = Array.from(parent.querySelectorAll(".agentic-chat-subagent-task"), (el) => el.textContent);
    expect(tasks).toEqual(["one", "other"]);
  });
});
