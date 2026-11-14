import { describe, expect, it, vi } from "vitest";
import type { AgenticChatSettings } from "../src/settings-schema";
import { SettingsStore } from "../src/settings-store";

function settings(mode = "agent"): AgenticChatSettings {
  return { mode } as unknown as AgenticChatSettings;
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("SettingsStore", () => {
  it("mutates and saves exactly once per update", async () => {
    const persist = vi.fn(async () => {});
    const store = new SettingsStore(settings(), persist);

    const saved = await store.update((s) => {
      (s as { mode: string }).mode = "plan";
    });

    expect(saved).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
    expect((persist.mock.calls[0] as unknown[])[0]).toMatchObject({ mode: "plan" });
  });

  it("skips the save and the listeners when the mutator returns false", async () => {
    const persist = vi.fn(async () => {});
    const listener = vi.fn();
    const store = new SettingsStore(settings(), persist);
    store.onChange(listener);

    expect(await store.update(() => false)).toBe(false);
    expect(persist).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it("notifies listeners only after the save resolves", async () => {
    const gate = deferred();
    const listener = vi.fn();
    const store = new SettingsStore(settings(), () => gate.promise);
    store.onChange(listener);

    const save = store.save();
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();

    gate.resolve();
    await save;
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not notify on a failed save, and the next save still runs", async () => {
    const persist = vi
      .fn<(s: AgenticChatSettings) => Promise<void>>()
      .mockRejectedValueOnce(new Error("secret store refused"))
      .mockResolvedValueOnce(undefined);
    const listener = vi.fn();
    const store = new SettingsStore(settings(), persist);
    store.onChange(listener);

    await expect(store.save()).rejects.toThrow("secret store refused");
    expect(listener).not.toHaveBeenCalled();

    await store.save();
    expect(persist).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("serializes writes: a second save starts only after the first one settles", async () => {
    const first = deferred();
    const order: string[] = [];
    const persist = vi
      .fn<(s: AgenticChatSettings) => Promise<void>>()
      .mockImplementationOnce(async () => {
        order.push("first:start");
        await first.promise;
        order.push("first:end");
      })
      .mockImplementationOnce(async () => {
        order.push("second:start");
      });
    const store = new SettingsStore(settings(), persist);

    const a = store.save();
    const b = store.save();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["first:start"]);

    first.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("keeps notifying other listeners when one throws, and unsubscribes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new SettingsStore(settings(), async () => {});
    const good = vi.fn();
    store.onChange(() => {
      throw new Error("boom");
    });
    const off = store.onChange(good);

    await store.save();
    expect(good).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);

    off();
    await store.save();
    expect(good).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("replace swaps the live object without saving or notifying", () => {
    const persist = vi.fn(async () => {});
    const listener = vi.fn();
    const store = new SettingsStore(settings("agent"), persist);
    store.onChange(listener);
    const next = settings("plan");

    store.replace(next);

    expect(store.settings).toBe(next);
    expect(persist).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });
});
