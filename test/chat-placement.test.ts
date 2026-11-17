import { describe, expect, it } from "vitest";
import { NARROW_WINDOW_PX, shouldCollapseLeftSidebar } from "../src/ui/chat-placement";

describe("shouldCollapseLeftSidebar", () => {
  it("leaves the sidebars alone on a normal desktop window", () => {
    expect(shouldCollapseLeftSidebar(1280, false, false)).toBe(false);
    expect(shouldCollapseLeftSidebar(NARROW_WINDOW_PX, false, false)).toBe(false);
  });

  it("collapses an open left sidebar in a narrow desktop window, where the chat would overflow", () => {
    expect(shouldCollapseLeftSidebar(390, false, false)).toBe(true);
    expect(shouldCollapseLeftSidebar(NARROW_WINDOW_PX - 1, false, false)).toBe(true);
  });

  it("does nothing when the left sidebar is already collapsed, or on Obsidian Mobile", () => {
    expect(shouldCollapseLeftSidebar(390, false, true)).toBe(false);
    expect(shouldCollapseLeftSidebar(390, true, false)).toBe(false);
  });
});
