/**
 * Seeded interleaving for multi-instance tests (#290).
 *
 * Several plugin instances (chat tabs, windows, a reload) share one adapter.
 * Their bugs (#279, #282) show up only under one ordering of awaits. This
 * helper wraps every async adapter method so it yields a seeded number of
 * macrotask turns before and after the real call. Running the same scenario
 * under many seeds explores many orderings; a failing seed replays exactly.
 */

/** mulberry32: small, fast, deterministic PRNG. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function macrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function yieldTurns(random: () => number, maxTurns: number): Promise<void> {
  const turns = Math.floor(random() * (maxTurns + 1));
  for (let i = 0; i < turns; i += 1) await macrotask();
}

const ADAPTER_METHODS = ["read", "write", "append", "exists", "mkdir", "remove", "rename", "list", "stat"] as const;

export interface InterleaveOptions {
  /** Most macrotask turns to yield around one call. Default 3. */
  maxTurns?: number;
}

/**
 * Wrap the adapter's async methods in place. Every instance that holds this
 * adapter sees the same seeded schedule.
 */
export function interleaveAdapter<T extends object>(adapter: T, seed: number, options: InterleaveOptions = {}): T {
  const random = seededRandom(seed);
  const maxTurns = options.maxTurns ?? 3;
  const target = adapter as Record<string, unknown>;
  for (const name of ADAPTER_METHODS) {
    const original = target[name];
    if (typeof original !== "function") continue;
    const bound = (original as (...args: unknown[]) => Promise<unknown>).bind(adapter);
    target[name] = async (...args: unknown[]) => {
      await yieldTurns(random, maxTurns);
      try {
        return await bound(...args);
      } finally {
        await yieldTurns(random, maxTurns);
      }
    };
  }
  return adapter;
}

/** Seeds 1..count. CI runs the same seeds every time, so a failure replays. */
export function seeds(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index + 1);
}
