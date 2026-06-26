import { describe, expect, it } from "vitest";
import { AgentSessionSwapQueue } from "../src/agent/session-swap-queue";

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("AgentSessionSwapQueue", () => {
  it("runs queued swaps serially", async () => {
    const queue = new AgentSessionSwapQueue();
    const first = deferred();
    const events: string[] = [];

    const firstRun = queue.enqueue(async () => {
      events.push("first:start");
      await first.promise;
      events.push("first:end");
    });
    const secondRun = queue.enqueue(async () => {
      events.push("second:start");
    });

    await flushMicrotasks();
    expect(events).toEqual(["first:start"]);

    first.resolve();
    await firstRun;
    await secondRun;

    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("reports a failed swap without poisoning later swaps", async () => {
    const queue = new AgentSessionSwapQueue();
    const events: string[] = [];
    const failure = new Error("load failed");

    await expect(
      queue.enqueue(async () => {
        events.push("first:start");
        throw failure;
      }),
    ).rejects.toThrow("load failed");

    await queue.enqueue(async () => {
      events.push("second:start");
    });

    expect(events).toEqual(["first:start", "second:start"]);
  });
});
