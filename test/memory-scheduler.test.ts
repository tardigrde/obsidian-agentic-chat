import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryScheduler, IDLE_DISTILL_MS } from "../src/ui/memory-scheduler";
import { DEFAULT_SETTINGS } from "../src/settings-schema";
import type { VaultMemorySettings } from "../src/memory/vault-memory";
import { MemoryAdapter } from "./helpers/memory-adapter";

const SETTINGS = {
  ...DEFAULT_SETTINGS,
  memory: { enabled: true, store: "plugin", vaultFolder: "memory", modelOverride: "" } as VaultMemorySettings,
};
const SESSION_DIR = ".obsidian/plugins/agentic-chat/sessions";

function sessionFile(id: string): string {
  const header = JSON.stringify({ type: "session", version: 1, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: "v" });
  const lines = [header];
  for (let i = 0; i < 5; i++) {
    lines.push(JSON.stringify({
      type: "message",
      id: `e${i}`,
      parentId: i === 0 ? null : `e${i - 1}`,
      timestamp: new Date(1_000 + i).toISOString(),
      message: {
        role: "user",
        content: [{ type: "text", text: `Substantial user question number ${i} about deployment pipelines, rollback runbooks, and on-call ownership` }],
        timestamp: 1_000 + i,
      },
    }));
  }
  return `${lines.join("\n")}\n`;
}

function scheduler(adapter: MemoryAdapter, overrides: Record<string, unknown> = {}): MemoryScheduler {
  return new MemoryScheduler({
    adapter: adapter.asDataAdapter(),
    configDir: ".obsidian",
    getSettings: () => SETTINGS,
    sessionCostUsd: () => 0,
    isQuiet: () => true,
    isClosed: () => false,
    distiller: async () => ["Scheduled bullet."],
    // Node timers so fake clocks drive the idle clock (production uses window).
    timers: {
      setTimeout: (fn: () => void, ms: number) => Number(setTimeout(fn, ms)),
      clearTimeout: (id: number) => clearTimeout(id),
    },
    ...overrides,
  });
}

describe("MemoryScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("startup sweep distills once when quiet at start", async () => {
    const adapter = new MemoryAdapter();
    await adapter.write(`${SESSION_DIR}/2026-01-01_a.jsonl`, sessionFile("a"));
    let calls = 0;
    const idle = scheduler(adapter, {
      distiller: async () => {
        calls += 1;
        return ["Scheduled bullet."];
      },
    });
    idle.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(1);
    expect(idle.getSummary()).toMatch(/^distilled v\d+/);
    idle.stop();
  });

  it("idle clock does not fire while disabled at startup", async () => {
    const adapter = new MemoryAdapter();
    await adapter.write(`${SESSION_DIR}/2026-01-01_a.jsonl`, sessionFile("a"));
    const idle = scheduler(adapter, { getSettings: () => DEFAULT_SETTINGS });
    idle.start();
    await vi.advanceTimersByTimeAsync(IDLE_DISTILL_MS + 1_000);
    expect(idle.getSummary()).toBe("idle");
    idle.stop();
  });

  it("skips the run while streaming and retries on the next clock", async () => {
    const adapter = new MemoryAdapter();
    await adapter.write(`${SESSION_DIR}/2026-01-01_a.jsonl`, sessionFile("a"));
    let quiet = false;
    const idle = scheduler(adapter, { isQuiet: () => quiet });
    idle.start();
    await vi.advanceTimersByTimeAsync(IDLE_DISTILL_MS + 1_000);
    // Startup sweep found work; the idle fire skipped while streaming.
    expect(idle.getSummary()).toBe("1 session(s) awaiting distill");
    quiet = true;
    await vi.advanceTimersByTimeAsync(IDLE_DISTILL_MS + 1_000);
    expect(idle.getSummary()).toMatch(/^distilled v\d+/);
    idle.stop();
  });

  it("debounces rapid boundary kicks into one run", async () => {
    const adapter = new MemoryAdapter();
    await adapter.write(`${SESSION_DIR}/2026-01-01_a.jsonl`, sessionFile("a"));
    let calls = 0;
    const idle = scheduler(adapter, {
      distiller: async () => {
        calls += 1;
        return ["Scheduled bullet."];
      },
    });
    idle.kick();
    idle.kick();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toBe(1);
    idle.stop();
  });
});
