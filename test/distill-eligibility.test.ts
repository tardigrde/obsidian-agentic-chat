import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { distillDailyToMemory, findEligibleSessions } from "../src/memory/distill-runtime";
import { parseMemoryFile, withSessionCoverage } from "../src/memory/vault-memory";
import type { DistillState } from "../src/memory/vault-memory";
import { DEFAULT_SETTINGS } from "../src/settings-schema";
import type { VaultMemorySettings } from "../src/memory/vault-memory";
import { MemoryAdapter } from "./helpers/memory-adapter";

const SETTINGS = {
  ...DEFAULT_SETTINGS,
  memory: { enabled: true, store: "plugin", vaultFolder: "memory", modelOverride: "" } as VaultMemorySettings,
};
const SESSION_DIR = ".obsidian/plugins/agentic-chat/sessions";

function sessionFile(id: string, userTexts: string[]): string {
  const header = JSON.stringify({ type: "session", version: 1, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: "v" });
  const lines = [header];
  userTexts.forEach((text, i) => {
    lines.push(JSON.stringify({
      type: "message",
      id: `e${i}`,
      parentId: i === 0 ? null : `e${i - 1}`,
      timestamp: new Date(1_000 + i).toISOString(),
      message: { role: "user", content: [{ type: "text", text }], timestamp: 1_000 + i },
    }));
  });
  return `${lines.join("\n")}\n`;
}

const MEATY = [
  "How should we structure the deployment pipeline for the staging environment rollout across all three regions with proper approvals?",
  "What are the rollback procedures when the database migration fails halfway through a production deploy on a Friday evening?",
  "Which team owns the on-call rotation for weekend production incidents and where is the escalation policy documented?",
  "Should we pin the homelab dependencies with lockfiles and run weekly vulnerability scans before promoting images?",
  "Where do we keep the runbook for restoring the vault from backup when sync produces conflict copies?",
];

async function seed(adapter: MemoryAdapter): Promise<void> {
  await adapter.write(`${SESSION_DIR}/2026-01-01_new.jsonl`, sessionFile("new", MEATY));
  await adapter.write(`${SESSION_DIR}/2026-01-01_tiny.jsonl`, sessionFile("tiny", ["hi"]));
}

describe("findEligibleSessions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-01T00:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("picks substantial sessions, skips trivia, newest-first", async () => {
    const adapter = new MemoryAdapter();
    await seed(adapter);
    const state: DistillState = { version: 0, pending: 0, failCount: 0 };
    const eligible = await findEligibleSessions(adapter.asDataAdapter(), SESSION_DIR, state);
    expect(eligible.map((session) => session.id)).toEqual(["new"]);
    expect(eligible[0]?.messages.length).toBeGreaterThan(0);
  });

  it("skips stat-unchanged files and resumes deltas positionally", async () => {
    const adapter = new MemoryAdapter();
    await seed(adapter);
    const data = adapter.asDataAdapter();
    let state: DistillState = { version: 0, pending: 0, failCount: 0 };
    const first = await findEligibleSessions(data, SESSION_DIR, state);
    expect(first.map((session) => session.id)).toEqual(["new"]);
    const stat = await data.stat(`${SESSION_DIR}/2026-01-01_new.jsonl`);
    state = withSessionCoverage(state, "new", {
      lastEntryId: "e0",
      version: 1,
      at: new Date().toISOString(),
      size: stat?.size ?? 0,
      mtime: stat?.mtime ?? 0,
    });
    // Same file, same stat → skipped without reading.
    expect(await findEligibleSessions(data, SESSION_DIR, state)).toEqual([]);
    // New message appended → stat differs → delta resumes after e0.
    await data.append(`${SESSION_DIR}/2026-01-01_new.jsonl`, sessionFile("new", MEATY).split("\n")[1] ?? "");
    const second = await findEligibleSessions(data, SESSION_DIR, state);
    expect(second.map((session) => session.id)).toEqual(["new"]);
  });

  it("falls back to full coverage when the marker id is gone", async () => {
    const adapter = new MemoryAdapter();
    await seed(adapter);
    const state: DistillState = {
      version: 0,
      pending: 0,
      failCount: 0,
      sessions: { new: { lastEntryId: "rewritten-away", version: 1, at: "" } },
    };
    const eligible = await findEligibleSessions(adapter.asDataAdapter(), SESSION_DIR, state);
    expect(eligible.map((session) => session.id)).toEqual(["new"]);
  });
});

describe("distill end-to-end with sessions", () => {
  it("distills eligible sessions, records coverage, then reports nothing eligible", async () => {
    const adapter = new MemoryAdapter();
    await seed(adapter);
    const data = adapter.asDataAdapter();
    const run = () =>
      distillDailyToMemory({
        adapter: data,
        configDir: ".obsidian",
        settings: SETTINGS,
        force: true,
        sessionDir: SESSION_DIR,
        distiller: async () => ["Distilled preference."],
      });
    const first = await run();
    expect(first.status).toBe("distilled");
    expect(parseMemoryFile(await data.read(".obsidian/plugins/agentic-chat/memory/MEMORY.md")).autoBullets)
      .toContain("Distilled preference.");
    const second = await distillDailyToMemory({
      adapter: data,
      configDir: ".obsidian",
      settings: SETTINGS,
      sessionDir: SESSION_DIR,
      distiller: async () => ["Should never be used."],
    });
    expect(second).toMatchObject({ status: "skipped", reason: "nothing eligible" });
  });
});
