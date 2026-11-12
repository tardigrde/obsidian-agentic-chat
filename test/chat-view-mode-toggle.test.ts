import { describe, expect, it, vi } from "vitest";
import { ChatView } from "../src/ui/chat-view";

function harness(mode: "safe" | "yolo") {
  const modeToggleEl = { toggleClass: vi.fn(), setAttr: vi.fn() };
  const view = Object.assign(Object.create(ChatView.prototype), {
    modeToggleEl,
    plugin: {
      settings: { mode },
      isAnyViewStreaming: () => false,
    },
    isAnyTabStreaming: () => false,
  }) as unknown as { syncControls: () => void };
  return { view, modeToggleEl };
}

describe("ChatView permission toggle", () => {
  it("names the safe mode for screen readers", () => {
    const { view, modeToggleEl } = harness("safe");

    view.syncControls();

    expect(modeToggleEl.setAttr).toHaveBeenCalledWith("aria-label", "Permission mode: Safe");
    expect(modeToggleEl.setAttr).toHaveBeenCalledWith("aria-checked", "false");
  });

  it("names the YOLO mode for screen readers", () => {
    const { view, modeToggleEl } = harness("yolo");

    view.syncControls();

    expect(modeToggleEl.setAttr).toHaveBeenCalledWith("aria-label", "Permission mode: YOLO");
    expect(modeToggleEl.setAttr).toHaveBeenCalledWith("aria-checked", "true");
  });
});
