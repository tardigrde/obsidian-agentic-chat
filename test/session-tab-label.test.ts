import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { MAX_TAB_LABEL_LENGTH, normalizeTabLabel, ObsidianSessionManager, SessionWriteRegistry } from "../src/session/session-manager";
import { parseSessionEntries } from "../src/session/jsonl";
import { FakeAdapter as MemoryAdapter } from "./support/fake-adapter";

const DEFAULTS = { provider: "openrouter", modelId: "x/y", thinkingLevel: "off" as const };

function userMessage(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as AgentMessage;
}

function manager(): { sm: ObsidianSessionManager; adapter: MemoryAdapter } {
  const adapter = new MemoryAdapter();
  const sm = new ObsidianSessionManager(adapter.asDataAdapter(), "sessions", "vault:test", new SessionWriteRegistry());
  return { sm, adapter };
}

/**
 * The tab label is its own `tab_label` field in the session JSONL. It is not
 * the session name: setting one never changes the other.
 */
describe("session tab label", () => {
  it("a session without a label has none, so its tab shows its number", async () => {
    const { sm } = manager();
    await sm.createSession(DEFAULTS);
    expect(sm.getActiveSessionInfo().tabLabel).toBeUndefined();
  });

  it("stores the label as a tab_label entry and keeps the session name", async () => {
    const { sm, adapter } = manager();
    const info = await sm.createSession(DEFAULTS);
    await sm.appendMessage(userMessage("plan the vendor review"));
    await sm.renameSession(info.path, "Vendor review");
    await sm.appendTabLabel("  Plan  ");

    expect(sm.getActiveSessionInfo()).toMatchObject({ name: "Vendor review", tabLabel: "Plan" });
    const entries = parseSessionEntries(await adapter.asDataAdapter().read(info.path));
    expect(entries.filter((entry) => entry.type === "tab_label")).toEqual([
      expect.objectContaining({ type: "tab_label", label: "Plan" }),
    ]);
  });

  it("survives a reload from disk and an empty label clears it", async () => {
    const { sm } = manager();
    const info = await sm.createSession(DEFAULTS);
    await sm.appendMessage(userMessage("hello"));
    await sm.appendTabLabel("Plan");
    await sm.createSession(DEFAULTS);
    expect((await sm.loadSession(info.path)).tabLabel).toBe("Plan");
    expect((await sm.listSessions()).find((session) => session.path === info.path)?.tabLabel).toBe("Plan");

    await sm.appendTabLabel("   ");
    expect(sm.getActiveSessionInfo().tabLabel).toBeUndefined();
    expect((await sm.loadSession(info.path)).tabLabel).toBeUndefined();
  });

  it("keeps the label across a transcript rewrite (prompt edit or compaction)", async () => {
    const { sm } = manager();
    await sm.createSession(DEFAULTS);
    await sm.appendMessage(userMessage("first"));
    await sm.appendMessage(userMessage("second"));
    await sm.appendTabLabel("Plan");
    await sm.rewriteMessages([userMessage("first")]);
    expect(sm.getActiveSessionInfo().tabLabel).toBe("Plan");
  });

  it("trims, joins whitespace, and caps the label", () => {
    expect(normalizeTabLabel(undefined)).toBeUndefined();
    expect(normalizeTabLabel(" \n ")).toBeUndefined();
    expect(normalizeTabLabel(" Weekly \n review ")).toBe("Weekly review");
    expect(normalizeTabLabel("x".repeat(80))).toHaveLength(MAX_TAB_LABEL_LENGTH);
  });
});
