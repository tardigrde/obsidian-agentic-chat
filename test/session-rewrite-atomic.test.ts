import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { ObsidianSessionManager } from "../src/session/session-manager";
import { parseSessionEntries } from "../src/session/jsonl";
import { MemoryAdapter } from "./helpers/memory-adapter";

const DEFAULTS = { provider: "openrouter", modelId: "x/y", thinkingLevel: "off" as const };

function userMessage(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as AgentMessage;
}

function manager(): { sm: ObsidianSessionManager; adapter: MemoryAdapter } {
  const adapter = new MemoryAdapter();
  const sm = new ObsidianSessionManager(adapter.asDataAdapter(), "sessions", "vault:test");
  return { sm, adapter };
}

function messageTexts(sm: ObsidianSessionManager): string[] {
  return sm.buildSessionContext().messages.map((message) => {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return "";
    return content
      .filter(
        (block): block is { type: "text"; text: string } =>
          typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text",
      )
      .map((block) => block.text)
      .join("");
  });
}

async function seeded(): Promise<{
  sm: ObsidianSessionManager;
  adapter: MemoryAdapter;
  path: string;
  original: string;
}> {
  const { sm, adapter } = manager();
  const info = await sm.createSession(DEFAULTS);
  await sm.appendMessage(userMessage("first"));
  await sm.appendMessage(userMessage("second"));
  await sm.appendMessage(userMessage("third"));
  const original = adapter.files.get(info.path);
  if (original === undefined) throw new Error("seeded session file missing");
  return { sm, adapter, path: info.path, original };
}

function sessionArtifacts(adapter: MemoryAdapter, path: string): string[] {
  return [...adapter.files.keys()].filter(
    (candidate) => candidate !== path && candidate.startsWith(path),
  );
}

describe("ObsidianSessionManager.rewriteMessages atomicity", () => {
  it("keeps the original session when the rewrite write throws", async () => {
    const { sm, adapter, path, original } = await seeded();
    const beforeMessages = messageTexts(sm);
    const beforeGeneration = sm.getActiveSessionGeneration();
    const originalWrite = adapter.write.bind(adapter);
    let failed = false;
    adapter.write = async (target, data) => {
      if (!failed) {
        failed = true;
        throw new Error("disk full");
      }
      return originalWrite(target, data);
    };

    await expect(sm.rewriteMessages([userMessage("rewound")])).rejects.toThrow("disk full");

    expect(adapter.files.get(path)).toBe(original);
    expect(messageTexts(sm)).toEqual(beforeMessages);
    expect(sm.getActiveSessionGeneration()).toBe(beforeGeneration);
    expect(sessionArtifacts(adapter, path)).toEqual([]);

    const reloaded = new ObsidianSessionManager(adapter.asDataAdapter(), "sessions", "vault:test");
    await reloaded.loadSession(path);
    expect(messageTexts(reloaded)).toEqual(beforeMessages);
  });

  it("keeps the original session when the rewrite write is torn", async () => {
    const { sm, adapter, path, original } = await seeded();
    const beforeMessages = messageTexts(sm);
    const beforeGeneration = sm.getActiveSessionGeneration();
    const originalWrite = adapter.write.bind(adapter);
    let torn = false;
    adapter.write = async (target, data) => {
      if (!torn) {
        torn = true;
        await originalWrite(target, data.slice(0, 24));
        throw new Error("torn write");
      }
      return originalWrite(target, data);
    };

    await expect(sm.rewriteMessages([userMessage("rewound")])).rejects.toThrow("torn write");

    expect(adapter.files.get(path)).toBe(original);
    expect(messageTexts(sm)).toEqual(beforeMessages);
    expect(sm.getActiveSessionGeneration()).toBe(beforeGeneration);
    expect(sessionArtifacts(adapter, path)).toEqual([]);

    const reloaded = new ObsidianSessionManager(adapter.asDataAdapter(), "sessions", "vault:test");
    await reloaded.loadSession(path);
    expect(messageTexts(reloaded)).toEqual(beforeMessages);
  });

  it("falls back safely when rename cannot overwrite the existing file", async () => {
    const { sm, adapter, path } = await seeded();
    const originalRename = adapter.rename.bind(adapter);
    let refused = false;
    adapter.rename = async (from, to) => {
      if (!refused) {
        refused = true;
        throw new Error("target exists");
      }
      return originalRename(from, to);
    };

    await sm.rewriteMessages([userMessage("rewound")]);

    expect(refused).toBe(true);
    const entries = parseSessionEntries(adapter.files.get(path) ?? "");
    expect(entries.filter((entry) => entry.type === "message")).toHaveLength(1);
    expect(messageTexts(sm)).toEqual(["rewound"]);
    expect(sessionArtifacts(adapter, path)).toEqual([]);

    const reloaded = new ObsidianSessionManager(adapter.asDataAdapter(), "sessions", "vault:test");
    await reloaded.loadSession(path);
    expect(messageTexts(reloaded)).toEqual(["rewound"]);
  });

  it("restores the original session when the fallback replace fails", async () => {
    const { sm, adapter, path, original } = await seeded();
    const beforeMessages = messageTexts(sm);
    const originalRename = adapter.rename.bind(adapter);
    let calls = 0;
    adapter.rename = async (from, to) => {
      calls += 1;
      if (calls === 1) throw new Error("rename over target unsupported");
      if (calls === 2) throw new Error("rename failed after remove");
      return originalRename(from, to);
    };

    await expect(sm.rewriteMessages([userMessage("rewound")])).rejects.toThrow(
      "rename failed after remove",
    );

    expect(adapter.files.get(path)).toBe(original);
    expect(messageTexts(sm)).toEqual(beforeMessages);
    expect(sessionArtifacts(adapter, path)).toEqual([]);

    const reloaded = new ObsidianSessionManager(adapter.asDataAdapter(), "sessions", "vault:test");
    await reloaded.loadSession(path);
    expect(messageTexts(reloaded)).toEqual(beforeMessages);
  });

  it("does not clean a temp file while its rewrite is in flight", async () => {
    const { sm, adapter, path } = await seeded();
    const originalWrite = adapter.write.bind(adapter);
    let tempPath: string | undefined;
    let started!: () => void;
    let release!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    adapter.write = async (target, data) => {
      if (target !== path && tempPath === undefined) {
        tempPath = target;
        await originalWrite(target, data);
        started();
        await gate;
        return;
      }
      return originalWrite(target, data);
    };

    const rewrite = sm.rewriteMessages([userMessage("rewound")]);
    const startedResult = await Promise.race([
      startedPromise.then(() => "started" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1_000)),
    ]);
    expect(startedResult).toBe("started");
    if (!tempPath) throw new Error("temp path missing");
    expect(adapter.files.has(tempPath)).toBe(true);

    const sessions = await sm.listSessions();
    expect(sessions.map((session) => session.path)).toEqual([path]);
    expect(adapter.files.has(tempPath)).toBe(true);

    release();
    await rewrite;
    expect(messageTexts(sm)).toEqual(["rewound"]);
    expect(adapter.files.has(tempPath)).toBe(false);
  });

  it("cleans a stale temp file and never lists it as a session", async () => {
    const { sm, adapter, path } = await seeded();
    const staleTemp = `${path}.tmp.stale`;
    adapter.files.set(staleTemp, "partial transcript");

    const sessions = await sm.listSessions();

    expect(sessions.map((session) => session.path)).toEqual([path]);
    expect(adapter.files.has(staleTemp)).toBe(false);
  });

  it("lists and restores a session that only has a backup file", async () => {
    const { sm, adapter, path, original } = await seeded();
    adapter.files.delete(path);
    adapter.files.set(`${path}.bak`, original);
    adapter.files.set(`${path}.tmp.stale`, "partial replacement");

    const sessions = await sm.listSessions();

    expect(sessions.map((session) => session.path)).toEqual([path]);
    expect(adapter.files.get(path)).toBe(original);
    expect(adapter.files.has(`${path}.bak`)).toBe(false);
    expect(adapter.files.has(`${path}.tmp.stale`)).toBe(false);
  });

  it("drops a stale backup once the main session is valid", async () => {
    const { adapter, path } = await seeded();
    adapter.files.set(`${path}.bak`, "older transcript");

    const reloaded = new ObsidianSessionManager(adapter.asDataAdapter(), "sessions", "vault:test");
    await reloaded.loadSession(path);

    expect(messageTexts(reloaded)).toEqual(["first", "second", "third"]);
    expect(adapter.files.has(`${path}.bak`)).toBe(false);
  });

  it("deletes a leftover backup with its session", async () => {
    const { sm, adapter, path } = await seeded();
    adapter.files.set(`${path}.bak`, "leftover backup");

    await sm.deleteSession(path);

    expect(adapter.files.has(path)).toBe(false);
    expect(adapter.files.has(`${path}.bak`)).toBe(false);
  });

  it("restores a truncated session from the backup on load", async () => {
    const { adapter, path, original } = await seeded();
    adapter.files.set(`${path}.bak`, original);
    adapter.files.set(path, original.slice(0, 24));

    const reloaded = new ObsidianSessionManager(adapter.asDataAdapter(), "sessions", "vault:test");
    await reloaded.loadSession(path);

    expect(messageTexts(reloaded)).toEqual(["first", "second", "third"]);
    expect(adapter.files.get(path)).toBe(original);
    expect(adapter.files.has(`${path}.bak`)).toBe(false);
  });
});
