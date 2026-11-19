import { describe, expect, it } from "vitest";
import {
  fitTabs,
  mostUrgentStatus,
  tabAriaLabel,
  tabDisplayLabel,
  tabStatus,
  tabTooltip,
} from "../src/ui/tab-status";

const idle = { needsApproval: false, streaming: false, error: false, unread: false };

describe("tab header rules", () => {
  it("a tab without a label shows its 1-based number; a label replaces it", () => {
    expect(tabDisplayLabel(0, undefined)).toBe("1");
    expect(tabDisplayLabel(2, "  ")).toBe("3");
    expect(tabDisplayLabel(1, "Plan")).toBe("Plan");
  });

  it("names the tab and its status for screen readers and the tooltip", () => {
    expect(tabAriaLabel(1, "Project plan", "needs-you")).toBe("Tab 2, Project plan, needs approval");
    expect(tabAriaLabel(0, undefined, null)).toBe("Tab 1");
    expect(tabTooltip(1, "Turn my meeting notes into a plan")).toBe("Tab 2 · Turn my meeting notes into a plan");
    expect(tabTooltip(0, undefined)).toBe("Tab 1 · New chat");
  });

  it("picks one status per tab, most urgent first", () => {
    expect(tabStatus(idle)).toBeNull();
    expect(tabStatus({ ...idle, unread: true })).toBe("unread");
    expect(tabStatus({ ...idle, streaming: true, unread: true })).toBe("running");
    expect(tabStatus({ ...idle, streaming: true, error: true })).toBe("running");
    expect(tabStatus({ ...idle, error: true, unread: true })).toBe("error");
    expect(tabStatus({ ...idle, needsApproval: true, streaming: true, error: true })).toBe("needs-you");
    expect(mostUrgentStatus([null, "unread", "running"])).toBe("running");
    expect(mostUrgentStatus(["running", "error", "needs-you"])).toBe("needs-you");
    expect(mostUrgentStatus([null, null])).toBeNull();
  });

  it("fits tabs in order, always keeps the active one, and reserves the overflow button", () => {
    expect(fitTabs([40, 40, 40], 200, 0, 50)).toEqual(new Set([0, 1, 2]));
    expect(fitTabs([0, 0, 0, 0, 0], 0, 3, 50)).toEqual(new Set([0, 1, 2, 3, 4]));
    // 5 tabs of 60px in 200px with a 50px reserve: 150px holds two tabs, the active one first.
    expect(fitTabs([60, 60, 60, 60, 60], 200, 4, 50)).toEqual(new Set([4, 0]));
    expect(fitTabs([60, 60, 60, 60, 60], 200, 0, 50)).toEqual(new Set([0, 1]));
  });
});
