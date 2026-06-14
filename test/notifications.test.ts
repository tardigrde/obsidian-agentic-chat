import { describe, expect, it } from "vitest";
import { highestUnnotifiedThreshold, Notifier } from "../src/ui/notifications";

describe("Notifier", () => {
  it("suppresses non-error notifications when disabled", () => {
    const fired: string[] = [];
    const notifier = new Notifier(() => false, (m) => fired.push(m));
    expect(notifier.notify("contextWindow", "ctx")).toBe(false);
    expect(notifier.notify("cost", "cost")).toBe(false);
    expect(fired).toEqual([]);
  });

  it("always emits errors even when disabled", () => {
    const fired: string[] = [];
    const notifier = new Notifier(() => false, (m) => fired.push(m));
    expect(notifier.notify("error", "boom")).toBe(true);
    expect(fired).toEqual(["boom"]);
  });

  it("emits background notifications when enabled", () => {
    const fired: string[] = [];
    const notifier = new Notifier(() => true, (m) => fired.push(m));
    expect(notifier.notify("agentFinished", "done")).toBe(true);
    expect(fired).toEqual(["done"]);
  });
});

describe("highestUnnotifiedThreshold", () => {
  it("returns the highest reached threshold not yet notified", () => {
    expect(highestUnnotifiedThreshold(0.92, [0.75, 0.9], new Set())).toBe(0.9);
    expect(highestUnnotifiedThreshold(0.8, [0.75, 0.9], new Set())).toBe(0.75);
  });

  it("returns null when below all thresholds", () => {
    expect(highestUnnotifiedThreshold(0.5, [0.75, 0.9], new Set())).toBeNull();
  });

  it("skips thresholds already notified", () => {
    expect(highestUnnotifiedThreshold(0.8, [0.75, 0.9], new Set([0.75]))).toBeNull();
    expect(highestUnnotifiedThreshold(0.95, [0.75, 0.9], new Set([0.75]))).toBe(0.9);
  });
});
