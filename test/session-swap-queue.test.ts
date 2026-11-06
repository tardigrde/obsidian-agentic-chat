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
    expect(queue.state).toBe("live");
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
    expect(queue.state).toBe("live");
  });

  it("moves idle -> queued -> loading -> activating -> live", async () => {
    const queue = new AgentSessionSwapQueue();
    const gate = deferred();
    const seen: string[] = [];

    expect(queue.state).toBe("idle");
    const run = queue.enqueue(async (setPhase) => {
      seen.push(queue.state);
      setPhase("activating");
      seen.push(queue.state);
      await gate.promise;
      return 42;
    });
    expect(queue.state).toBe("queued");

    gate.resolve();
    await expect(run).resolves.toBe(42);
    expect(seen).toEqual(["loading", "activating"]);
    expect(queue.state).toBe("live");
    await expect(queue.waitForSettled()).resolves.toBe("live");
  });

  it("reports a failed state and recovers on the next enqueue", async () => {
    const queue = new AgentSessionSwapQueue();
    await expect(
      queue.enqueue(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(queue.state).toBe("failed");
    await expect(queue.waitForSettled()).resolves.toBe("failed");

    await queue.enqueue(async (setPhase) => {
      setPhase("loading");
    });
    expect(queue.state).toBe("live");
  });

  it("waits for every queued swap before returning the state", async () => {
    const queue = new AgentSessionSwapQueue();
    const gate = deferred();
    const run = queue.enqueue(async () => {
      await gate.promise;
    });
    let settled = false;
    const wait = queue.waitForSettled().then((state) => {
      settled = true;
      return state;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    gate.resolve();
    await run;
    await expect(wait).resolves.toBe("live");
    expect(settled).toBe(true);
  });
});
