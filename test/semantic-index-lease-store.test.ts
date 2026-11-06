import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { IndexedDbSemanticLeaseStore } from "../src/retrieval/semantic-index-lease-store";

describe("IndexedDbSemanticLeaseStore", () => {
  it("serializes acquire and release across two store instances", async () => {
    const first = new IndexedDbSemanticLeaseStore();
    const second = new IndexedDbSemanticLeaseStore();
    const key = `store/${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

    await expect(first.tryAcquire(key, "owner-a", 1_000, 60_000)).resolves.toBe(true);
    await expect(second.tryAcquire(key, "owner-b", 1_000, 60_000)).resolves.toBe(false);

    await first.release(key, "owner-a");
    await expect(second.tryAcquire(key, "owner-b", 1_000, 60_000)).resolves.toBe(true);
    await second.release(key, "owner-b");
  });

  it("lets exactly one of two concurrent acquires win", async () => {
    const first = new IndexedDbSemanticLeaseStore();
    const second = new IndexedDbSemanticLeaseStore();
    const key = `race/${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

    const results = await Promise.all([
      first.tryAcquire(key, "owner-a", 1_000, 60_000),
      second.tryAcquire(key, "owner-b", 1_000, 60_000),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    await first.release(key, "owner-a");
    await second.release(key, "owner-b");
  });

  it("lets a new owner take an expired record", async () => {
    const store = new IndexedDbSemanticLeaseStore();
    const key = `expired/${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

    await expect(store.tryAcquire(key, "owner-a", 1_000, 60_000)).resolves.toBe(true);
    await expect(store.tryAcquire(key, "owner-b", 61_001, 60_000)).resolves.toBe(true);
    await store.release(key, "owner-b");
  });
});
