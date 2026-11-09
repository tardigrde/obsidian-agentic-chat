import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapSemanticIndex, SemanticIndexLeaseRegistry } from "../src/retrieval/semantic-index";
import type { SemanticLeaseRecord, SemanticLeaseStore } from "../src/retrieval/semantic-index-lease-store";
import { semanticIndexLeaseFailureMessage } from "../src/ui/semantic-index-workflow-controller";
import { MemoryAdapter } from "./helpers/memory-adapter";
import { DeterministicFakeEmbedder, MULTILINGUAL_RETRIEVAL_FIXTURE } from "./helpers/retrieval-fixtures";

/** In-memory stand-in for the IndexedDB store, shared by both "plugin loads". */
function memoryStore(): SemanticLeaseStore & { calls: number } {
  const records = new Map<string, SemanticLeaseRecord>();
  const store = {
    calls: 0,
    async tryAcquire(path: string, ownerId: string, now: number, ttlMs: number) {
      store.calls += 1;
      const record = records.get(path);
      if (record && record.ownerId !== ownerId && now - record.touchedAt < ttlMs) return false;
      records.set(path, { path, ownerId, touchedAt: now });
      return true;
    },
    async release(path: string, ownerId: string) {
      if (records.get(path)?.ownerId === ownerId) records.delete(path);
    },
    async peek(path: string) {
      return records.get(path);
    },
  };
  return store;
}

const scope = { kind: "folder" as const, label: "Projects", paths: ["Projects"] };

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("semantic index heartbeat lease (#282)", () => {
  it("lets a reloaded plugin take over a crashed lease after the heartbeat TTL, not 30 minutes", async () => {
    // Fake timers: the crashed load's heartbeat never fires, as after a real crash.
    vi.useFakeTimers();
    const store = memoryStore();
    const path = "heartbeat/reload/index.json";
    let now = 1_000_000;
    const crashed = new SemanticIndexLeaseRegistry(() => now, undefined, store);
    expect(await crashed.acquireDurable(path)).not.toBeNull();
    // No release: the plugin reloaded mid-index. The next load has a new owner id.
    const reloaded = new SemanticIndexLeaseRegistry(() => now, undefined, store);

    now += 30_000;
    const adapter = new MemoryAdapter();
    const blocked = await bootstrapSemanticIndex({
      adapter: adapter.asDataAdapter(),
      path,
      scope,
      documents: MULTILINGUAL_RETRIEVAL_FIXTURE.slice(0, 1),
      embedder: new DeterministicFakeEmbedder(),
      batchSize: 1,
      leases: reloaded,
    });
    expect(blocked.leaseFailure).toEqual({ reason: "held", heldForMs: 30_000, retryInMs: 90_000 });
    const message = semanticIndexLeaseFailureMessage(blocked.leaseFailure!);
    expect(message).toMatch(/30 s ago/);
    expect(message).toMatch(/retry in about 90 s/);
    expect(message).not.toMatch(/cancel there first/);
    expect(adapter.files.has(path)).toBe(false);

    now += 90_000;
    const recovered = await reloaded.acquireDurable(path);
    expect(recovered).not.toBeNull();
    await recovered!.release();
  });

  it("renews on a timer while held and stops the timer after release", async () => {
    vi.useFakeTimers();
    const store = memoryStore();
    const registry = new SemanticIndexLeaseRegistry(Date.now, undefined, store);
    const lease = await registry.acquireDurable("heartbeat/timer/index.json");
    expect(lease).not.toBeNull();
    expect(store.calls).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(store.calls).toBe(2);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(store.calls).toBe(12);
    // A long batch with no persisted progress still owns the lease.
    expect(lease!.isOwned()).toBe(true);

    await lease!.release();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(store.calls).toBe(12);
  });
});
